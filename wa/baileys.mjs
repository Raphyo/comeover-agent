// WhatsApp adapter on Baileys (unofficial, linked-device). Every adapter keeps this contract:
//
//   const wa = createWhatsApp({ onMessage, phone?, dir? })
//   await wa.start()                     // links the device (QR, or a pairing code when `phone` is set) and reconnects on drops
//   await wa.send(chatId, text, { quote? })  // plain-text message; `quote` is a raw message to reply-quote
//   await wa.typing(chatId, true|false)      // typing indicator
//   await wa.groupInfo(chatId)               // { subject, size } for a group, cached
//   wa.stop()
//
//   onMessage({ chatId, sender, senderName, text, isGroup, isSelfChat, mentionedMe, replyToBot, fromMe, raw })
//     chatId      where to reply (a 1:1 chat or a group)
//     sender      the author's phone number, digits only; senderName is their WhatsApp display name
//     isSelfChat  the owner's "message yourself" chat
//     mentionedMe the bot was @-mentioned (groups); replyToBot: the message quotes one the bot sent
//     fromMe      typed by the owner on their phone (the bot shares the owner's number)
//
// Side files in `dir`: auth/ (session, as sensitive as a logged-in phone), qr.png and pair.txt (for qr.html while linking).
import path from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } from "baileys";
import qrcode from "qrcode-terminal";
import QR from "qrcode";
import pino from "pino";

const num = jid => (jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");

export function createWhatsApp({ onMessage, onReady = () => {}, onAdded = () => {}, onStatus = () => {}, phone = "", dir = process.cwd() }) {
  const PHONE = String(phone).replace(/\D/g, "");
  const pairFile = path.join(dir, "pair.txt");
  const sent = new Set();   // ids of our own messages, so the echo never comes back as input
  const names = new Map();  // number -> display name, learned from the messages people send
  let sock = null, stopped = false;
  let pairingAsked = false; // one pairing code per run: asking again cancels the code the person is typing

  const me = () => [num(sock?.user?.id), num(sock?.user?.lid)].filter(Boolean);

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(dir, "auth"));
    const { version } = await fetchLatestBaileysVersion();
    // With a pairing code the person needs time to type it, so the link window is longer and must not reset mid-way.
    sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }), browser: Browsers.macOS("Chrome"), markOnlineOnConnect: false, qrTimeout: PHONE ? 180000 : 60000 });
    sock.ev.on("creds.update", saveCreds);
    watchMembership();

    sock.ev.on("connection.update", async u => {
      if (u.qr) {
        if (PHONE && !state.creds.registered) {
          if (pairingAsked) return; // waiting for the code already shown
          pairingAsked = true;
          try {
            const code = await sock.requestPairingCode(PHONE);
            const pretty = String(code).replace(/[^A-Z0-9]/gi, "").replace(/(.{4})(?=.)/g, "$1-");
            writeFileSync(pairFile, pretty);
            console.log(`\n======================\n  Pairing code: ${pretty}\n======================\nWhatsApp > Settings > Linked devices > Link a device > Link with phone number instead\n`);
            return;
          } catch (e) { console.log("[wa] pairing code failed (" + (e?.message || e) + "), showing the QR instead"); }
        }
        console.log("\nScan with WhatsApp: Settings > Linked devices > Link a device (valid 60 s; also at http://localhost:8766/qr.html)\n");
        qrcode.generate(u.qr, { small: true });
        QR.toFile(path.join(dir, "qr.png"), u.qr, { width: 480, margin: 2 }).catch(() => {});
      }
      if (u.connection === "open") {
        rmSync(pairFile, { force: true });
        console.log(`[wa] connected as ${num(sock.user?.id)}`);
        onStatus(`Connected to WhatsApp as +${num(sock.user?.id)}.`);
        setTimeout(() => { try { onReady(); } catch {} }, 2000);
      }
      if (u.connection === "close" && !stopped) {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut && !state.creds.registered) {
          // A pairing that did not go through: start clean and show a fresh code.
          console.log("[wa] pairing was rejected; starting over with a new code");
          onStatus("Pairing was rejected; a new code is being prepared.");
          rmSync(path.join(dir, "auth"), { recursive: true, force: true });
          pairingAsked = false;
          setTimeout(connect, 1500);
        } else if (code === DisconnectReason.loggedOut) { console.log("[wa] logged out. Delete ./auth and restart."); onStatus("Logged out of WhatsApp. The auth folder must be cleared and the bot restarted."); }
        else { console.log("[wa] connection closed (" + code + "), reconnecting"); setTimeout(connect, 1500); }
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        const chatId = m.key.remoteJid || "";
        if (!m.message || chatId === "status@broadcast" || sent.has(m.key.id)) continue;
        const body = m.message.ephemeralMessage?.message || m.message;
        let text = (body.conversation || body.extendedTextMessage?.text || body.imageMessage?.caption || "").trim();
        // A shared location (one-off or live) becomes a line the agent can read.
        const loc = body.locationMessage || body.liveLocationMessage;
        if (!text && loc && loc.degreesLatitude != null) {
          const lat = (+loc.degreesLatitude).toFixed(5), lng = (+loc.degreesLongitude).toFixed(5);
          const label = [loc.name, loc.address, loc.caption].filter(Boolean).join(", ");
          text = `[shared ${body.liveLocationMessage ? "live " : ""}location: ${lat},${lng}${label ? " (" + label + ")" : ""} https://maps.google.com/?q=${lat},${lng}]`;
        }
        if (!text) continue;
        const isGroup = chatId.endsWith("@g.us");
        const own = me();
        const ctx = body.extendedTextMessage?.contextInfo || {};
        const sender = num(isGroup ? (m.key.participantAlt || m.key.participant) : (m.key.remoteJidAlt || chatId));
        if (m.pushName && !m.key.fromMe) for (const j of [m.key.participant, m.key.participantAlt, chatId, m.key.remoteJidAlt]) if (j) names.set(num(j), m.pushName);
        onMessage({
          chatId,
          sender,
          senderName: m.key.fromMe ? (sock.user?.name || "Me") : (m.pushName || sender),
          text,
          isGroup,
          isSelfChat: !isGroup && own.includes(num(chatId)),
          mentionedMe: (ctx.mentionedJid || []).some(j => own.includes(num(j))),
          replyToBot: !!ctx.stanzaId && sent.has(ctx.stanzaId),
          fromMe: !!m.key.fromMe,
          raw: m
        });
      }
    });
  }

  // The bot being added to a group: a moment to introduce itself.
  function watchMembership() {
    sock.ev.on("group-participants.update", u => {
      if (u.action === "add" && (u.participants || []).some(p => me().includes(num(typeof p === "string" ? p : p?.id)))) {
        groupCache.delete(u.id);
        try { onAdded(u.id); } catch {}
      }
    });
  }

  const groupCache = new Map();
  return {
    start: connect,
    stop() { stopped = true; try { sock?.end?.(); } catch {} },
    async send(chatId, text, { quote } = {}) {
      const r = await sock.sendMessage(chatId, { text }, quote ? { quoted: quote } : {});
      if (r?.key?.id) sent.add(r.key.id);
    },
    async groupInfo(chatId) {
      if (!groupCache.has(chatId)) {
        try {
          const md = await sock.groupMetadata(chatId);
          const own = me();
          const members = (md.participants || []).map(p => {
            const ids = [p.phoneNumber, p.jid, p.id, p.lid].filter(Boolean).map(num);
            const number = ids.find(n => names.has(n)) || num(p.phoneNumber || p.jid || p.id);
            return { number, name: names.get(number) || null, admin: !!p.admin, me: ids.some(n => own.includes(n)) };
          });
          groupCache.set(chatId, { subject: md.subject || "", size: members.length, members });
        } catch { return { subject: "", size: 0, members: [] }; }
      }
      const g = groupCache.get(chatId);
      for (const m of g.members) if (!m.name && names.has(m.number)) m.name = names.get(m.number); // names fill in as people talk
      return g;
    },
    async typing(chatId, on = true) {
      await sock.sendPresenceUpdate(on ? "composing" : "paused", chatId).catch(() => {});
    },
    // The number behind a display name seen in the chats, for sending someone a private message.
    numberFor(name) {
      const n = String(name).trim().toLowerCase();
      for (const [number, pushName] of names) if (pushName.toLowerCase() === n && /^\d{7,15}$/.test(number) && !number.startsWith("1203")) return number;
      return null;
    }
  };
}
