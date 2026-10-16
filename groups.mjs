// Group policy: when the bot speaks in a group, and what the agent gets to read.
//
// Idle: it reads everything and keeps it as context, says nothing.
// It engages when addressed: "come over" in the text, an @-mention, or a reply to one of its own messages.
// Engaged: from then until ten minutes after its last exchange, everything said in the group goes to it (the agent
// itself decides whether a message needs an answer and stays silent otherwise). Then it goes idle again.
//
//   const policy = createGroupPolicy({ file })   // state is kept in `file`, so a restart does not drop an exchange
//   policy.consider(m)            -> true when this message should start (or join) an agent turn
//   policy.drain(chatId, meta)    -> the text for the agent: everything said since its last reply, as "Name: text"
//   policy.afterReply(chatId)     -> call when the bot has replied
//   policy.resume()               -> chats with unanswered messages from before a restart
import { readFileSync, writeFileSync } from "node:fs";

export function createGroupPolicy({ windowMs = 10 * 60 * 1000, debounceMs = 3000, file = null, ownerName = "the owner" } = {}) {
  const groups = new Map(); // chatId -> { buffer, engagedUntil, awaiting, introduced }
  if (file) { try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) groups.set(k, v); } catch {} }
  const save = () => { if (file) { try { writeFileSync(file, JSON.stringify(Object.fromEntries(groups))); } catch {} } };
  const ADDRESSED = /\bcome ?over\b/i;

  const state = id => {
    let g = groups.get(id);
    if (!g) groups.set(id, g = { buffer: [], engagedUntil: 0, awaiting: false, introduced: false });
    return g;
  };

  function consider(m) {
    const g = state(m.chatId);
    g.buffer.push(`${m.senderName}: ${m.text}`);
    if (g.buffer.length > 60) g.buffer.splice(0, g.buffer.length - 60);
    const now = Date.now();
    const addressed = m.mentionedMe || m.replyToBot || ADDRESSED.test(m.text);
    const inExchange = now < g.engagedUntil && (g.awaiting || m.fromMe);
    const turn = addressed || inExchange;
    if (turn) { g.engagedUntil = now + windowMs; g.awaiting = true; }
    save();
    return turn;
  }

  // meta: { subject, size, roster, known } — roster is the member list, known is what memory holds about them.
  function drain(chatId, meta = {}) {
    const g = state(chatId);
    const lines = g.buffer.splice(0);
    const head = [];
    if (!g.introduced) head.push(`(You are in the WhatsApp group "${meta.subject || "group"}" with ${meta.size || "several"} people. Messages arrive as "Name: text"; ${ownerName} is the owner, marked "(owner)". Reply to the group, briefly, using names.)`);
    if (meta.roster) head.push(`(Members: ${meta.roster})`);
    if (meta.known) head.push(`(What you remember: ${meta.known})`);
    g.introduced = true;
    save();
    return (head.length ? head.join("\n") + "\n" : "") + "New messages:\n" + lines.join("\n");
  }

  function afterReply(chatId) {
    const g = state(chatId);
    g.engagedUntil = Date.now() + windowMs;
    g.awaiting = true;
    save();
  }

  // For the classifier: is the group idle, what was said last, and a way to open an exchange from its verdict.
  const isIdle = chatId => { const g = state(chatId); return !(Date.now() < g.engagedUntil && g.awaiting); };
  const recent = (chatId, n = 8) => state(chatId).buffer.slice(-n);
  const engage = chatId => { const g = state(chatId); g.engagedUntil = Date.now() + windowMs; g.awaiting = true; save(); };

  function resume() {
    const now = Date.now();
    return [...groups].filter(([, g]) => g.buffer.length && now < g.engagedUntil && g.awaiting).map(([id]) => id);
  }

  return { consider, drain, afterReply, resume, isIdle, recent, engage, debounceMs };
}
