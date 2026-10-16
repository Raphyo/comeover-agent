// Come Over, proof of concept: WhatsApp in, agent out.
// Run: node bot.mjs   (first time: link the device via the QR, or PHONE=32... for a pairing code)
//   OWNER=9725...   your own number: the person the bot books for and asks before paying (needed when the bot has its own number)
//   OWNER_NAME=Raph how the agent refers to you
//   MODEL=opus      pick the agent's model
//   ALLOW=all       1:1 chats it answers besides the owner: "all", or comma-separated numbers
//   GROUPS=all      groups it may speak in: "all", or comma-separated fragments of group names ("friday crew,family")
import path from "node:path";
import { readFileSync, appendFileSync, statSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

// On a server, keep a copy of the console in DATA_DIR/bot.log (Maritime's log view does not show the container's stdout).
if (process.env.DATA_DIR) {
  const logFile = path.join(process.env.DATA_DIR, "bot.log");
  try { if (statSync(logFile).size > 5e6) renameSync(logFile, logFile + ".1"); } catch {}
  for (const k of ["log", "error", "warn"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { orig(...a); try { appendFileSync(logFile, new Date().toISOString().slice(0, 19) + " " + a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n"); } catch {} };
  }
}
import { createWhatsApp } from "./wa/baileys.mjs";
import { createBrain, startBrowser } from "./brain.mjs";
import { startVaultWeb } from "./vault-web.mjs";
import { createGroupPolicy } from "./groups.mjs";
import { shouldStepIn } from "./classify.mjs";
import { describe as remembered, setField } from "./memory-mcp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER = (process.env.OWNER || "").replace(/\D/g, "");
const OWNER_NAME = process.env.OWNER_NAME || "the owner";
const ALLOW = (process.env.ALLOW || "").split(",").map(n => n.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
const GROUPS = (process.env.GROUPS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

if (OWNER) setField(OWNER_NAME, "phone", "+" + OWNER); // the agent must never ask the owner for a number it already has

const brain = createBrain({ dir: HERE, model: process.env.MODEL });
const browser = await startBrowser(HERE, process.env.MCP_PORT);
const DATA = process.env.DATA_DIR || HERE; // on a server, /data survives restarts
const policy = createGroupPolicy({ file: path.join(DATA, "groups.json"), ownerName: OWNER_NAME });
const queues = new Map();      // chatId -> { busy, pending[] }: one agent turn at a time per chat
const groupTimers = new Map(); // chatId -> debounce timer, so a burst of messages becomes one turn

// The owner: messages typed on the bot's own phone, or from the OWNER number when the bot has a number of its own.
const isOwner = m => m.fromMe || (OWNER && m.sender === OWNER);
// 1:1 chats: the owner, plus ALLOW ("all" or listed numbers). Groups: the GROUPS list, and only when the policy says it was addressed.
const wanted = m => !m.isGroup && (m.isSelfChat || isOwner(m) || ALLOW.includes("all") || ALLOW.includes(m.sender));

async function groupAllowed(chatId) {
  if (!GROUPS.length) return false;
  if (GROUPS.includes("all")) return true;
  const { subject } = await wa.groupInfo(chatId);
  return GROUPS.some(f => subject.toLowerCase().includes(f));
}

// What the agent is told about a group at the start of a turn: who is in it, and what memory holds about them.
async function groupBrief(chatId) {
  const info = await wa.groupInfo(chatId);
  const others = info.members.filter(m => !m.me);
  const label = m => (m.name || "+" + m.number) + (m.number === OWNER ? " (owner)" : "");
  const roster = others.map(label).join(", ") + (others.some(m => !m.name) ? " (numbers are people who have not written yet)" : "");
  const known = others.map(m => m.name && remembered(m.name)).filter(Boolean).join(" | ");
  return { subject: info.subject, size: others.length, roster, known };
}

// Added to a group: say hello once and start getting to know people.
async function onAdded(chatId) {
  if (!(await groupAllowed(chatId))) return;
  console.log("[grp] added to " + chatId);
  policy.engage(chatId);
  const note = "(system note: you were just added to this group. Introduce yourself in two short lines: who you are and what you do for the group, and that you only speak up when asked or when there is a plan to make. Then ask one light question to get to know people, such as what they like doing together or where in town they are. One question, no list.)";
  enqueue(chatId, policy.drain(chatId, await groupBrief(chatId)) + "\n" + note, { group: true });
}

function onMessage(m) {
  if (m.isGroup) return onGroupMessage(m);
  if (!wanted(m)) { if (!m.chatId.endsWith("@newsletter")) console.log("[wa] ignored " + m.chatId); return; }
  const owner = m.isSelfChat || isOwner(m);
  console.log(`[${owner ? "owner" : m.senderName}] ` + m.text);
  // The agent is told who it is talking to and what it already knows about them, every turn.
  const name = owner ? OWNER_NAME : m.senderName;
  const known = remembered(name);
  const head = (owner ? "" : `(1:1 chat with ${m.senderName}, a friend of ${OWNER_NAME}, not the owner)\n`) + (known ? `(What you remember: ${known})\n` : "");
  enqueue(m.chatId, head + `${name}${owner ? " (owner)" : ""}: ${m.text}`);
}

async function onGroupMessage(m) {
  if (!(await groupAllowed(m.chatId))) return;
  if (isOwner(m)) m.senderName = OWNER_NAME + " (owner)";
  let turn = policy.consider({ ...m, fromMe: isOwner(m) });
  const line = `[grp] ${m.senderName}: ${m.text.replace(/\n/g, " ").slice(0, 80)}`;
  // Not addressed outright and the group is idle: let a small model judge whether this is for the bot.
  if (!turn && policy.isIdle(m.chatId) && /\S\s+\S/.test(m.text)) {
    const t0 = Date.now();
    turn = await shouldStepIn(policy.recent(m.chatId));
    if (turn) policy.engage(m.chatId);
    console.log(`${line}  -> classifier: ${turn ? "for the bot" : "not for the bot"} (${Date.now() - t0} ms)`);
  } else console.log(line + (turn ? "  -> turn" : ""));
  if (!turn) return;
  clearTimeout(groupTimers.get(m.chatId));
  groupTimers.set(m.chatId, setTimeout(async () => {
    enqueue(m.chatId, policy.drain(m.chatId, await groupBrief(m.chatId)), { quote: m.raw, group: true });
  }, policy.debounceMs));
}

// Runs one agent turn per chat at a time; messages that arrive mid-turn are joined into the next one.
async function enqueue(chatId, text, opts = {}) {
  let q = queues.get(chatId);
  if (!q) queues.set(chatId, q = { busy: false, pending: [] });
  q.pending.push(text);
  if (q.busy) return;

  q.busy = true;
  try {
    while (q.pending.length) {
      // The server's clock may be in another zone than the people; the agent gets the local date and time every turn.
      const now = new Date().toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
      const input = `(now: ${now})\n` + q.pending.splice(0).join("\n");
      wa.typing(chatId, true);
      const keepTyping = setInterval(() => wa.typing(chatId, true), 8000);
      let chain = Promise.resolve(); // sends stay in order even though the agent streams
      await brain.reply(chatId, input, t => {
        if (/^[.\s]*$/.test(t)) { console.log("[bot] (stays silent)"); return; } // "." is the agent's way of saying nothing
        chain = chain
          .then(() => wa.send(chatId, t, { quote: opts.quote }))
          .then(() => { console.log("[bot] " + t.replace(/\n/g, " ").slice(0, 160)); if (opts.group) policy.afterReply(chatId); })
          .catch(e => console.log("[wa] send failed", e?.message));
      });
      await chain;
      clearInterval(keepTyping);
      wa.typing(chatId, false);
    }
  } finally { q.busy = false; }
}

// The web vault: the agent asks for a card or an ID through a one-time link, the person types it on their phone, and the
// agent hears back here. Links go to the person in a private chat when their number is known, so nothing lands in a group.
// Maritime injects PORT and expects /health and /chat there; the vault pages share that server.
const VAULT_PORT = String(process.env.PORT || process.env.VAULT_PORT || 8787);
process.env.VAULT_PORT = VAULT_PORT; // the card tool server, a child of each agent run, posts its link requests to this port
const vault = await startVaultWeb({
  port: +VAULT_PORT,
  status: () => {
    try { const pair = readFileSync(path.join(DATA, "pair.txt"), "utf8").trim(); if (pair) return `Not linked to WhatsApp yet. Pairing code: ${pair} (WhatsApp > Linked devices > Link with phone number instead)`; } catch {}
    return waStatus;
  },
  async onIssued(spec, url) {
    const isOwnerWho = /^owner$/i.test(spec.who) || spec.who.toLowerCase() === OWNER_NAME.toLowerCase();
    const number = isOwnerWho ? OWNER : wa.numberFor(spec.who);
    if (!number) return false;
    const chat = number + "@s.whatsapp.net";
    if (chat === spec.chatId || spec.chatId === "") return false; // already a private chat with that person: the agent posts it
    await wa.send(chat, spec.kind === "overview"
      ? `Here's your vault. Private link, valid 15 minutes: ${url}`
      : `Here's your private link to add ${spec.title}. One-time, valid 15 minutes, never type it in the chat: ${url}`);
    return true;
  },
  onSaved(chatId, info) {
    const what = info.kind === "card" ? `card ${info.masked}` : info.kind === "login" ? `their ${info.site} login` : `${info.title} (${info.keys.join(", ")})`;
    const next = info.kind === "card" ? "; still ask for a yes before any payment" : info.kind === "login" ? ", using login_fill on the site's sign-in page" : ", using vault_fill when the form needs it";
    console.log(`[vault] ${what} saved by ${info.who} for ${chatId || "(unknown chat)"}`);
    if (chatId) enqueue(chatId, `(system note, not written by a person) ${info.who === "owner" ? OWNER_NAME : info.who} just saved ${what} to the vault through the secure link. Confirm in a few words and continue what was pending${next}.`);
  }
});

let waStatus = "Starting up.";
const wa = createWhatsApp({
  onMessage, phone: process.env.PHONE, dir: DATA,
  onStatus: s => { waStatus = s; },
  // After a restart, answer anything a group said while the bot was down mid-exchange.
  onReady: async () => {
    for (const chatId of policy.resume()) {
      console.log("[grp] resuming " + chatId);
      enqueue(chatId, policy.drain(chatId, await groupBrief(chatId)), { group: true });
    }
  },
  onAdded
});
process.on("SIGINT", () => { browser.kill(); vault.close(); wa.stop(); process.exit(0); });
await wa.start();
