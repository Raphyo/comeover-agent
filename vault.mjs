// The vault: everything sensitive, AES-256-GCM encrypted in vault.enc with a key kept in the macOS Keychain.
//   { card: { number, exp, cvc, name },
//     secrets: { "<person>": { israeli_id: "...", passport: "..." } },
//     logins:  { "<person>": { "<site>": { username, password, totp?, agent?, savedAt } } } }
// Only card-mcp.mjs (which types values into forms) and vault-web.mjs (which collects them) read this file.
// CLI: node vault.mjs show | remove-card | remove <person> <key> | remove-login <person> <site> | wipe
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(process.env.DATA_DIR || HERE, "vault.enc");
const ITEM = ["-a", "comeover", "-s", "comeover-vault-key"];

function key() {
  // On a server the key is an encrypted env var (64 hex chars); on a Mac it lives in the Keychain.
  if (process.env.VAULT_KEY) return Buffer.from(process.env.VAULT_KEY, "hex");
  try {
    return Buffer.from(execFileSync("security", ["find-generic-password", ...ITEM, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "hex");
  } catch {
    const k = randomBytes(32);
    execFileSync("security", ["add-generic-password", ...ITEM, "-U", "-w", k.toString("hex")], { stdio: "ignore" });
    return k;
  }
}

function readAll() {
  if (!existsSync(FILE)) return {};
  const j = JSON.parse(readFileSync(FILE, "utf8"));
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(j.iv, "base64"));
  d.setAuthTag(Buffer.from(j.tag, "base64"));
  const v = JSON.parse(Buffer.concat([d.update(Buffer.from(j.data, "base64")), d.final()]).toString());
  return v.number ? { card: v } : v; // a vault written when it held only the card
}
function writeAll(v) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(v)), c.final()]);
  writeFileSync(FILE, JSON.stringify({ iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
}

const who = name => String(name).trim().toLowerCase().replace(/\s*\(owner\)$/, "");
export const mask = n => "•••• " + String(n).slice(-4);

export function saveCard(card) { const v = readAll(); v.card = card; writeAll(v); }
export function readCard() { return readAll().card || null; }
export function setSecret(person, k, value) { const v = readAll(); ((v.secrets ||= {})[who(person)] ||= {})[k] = value; writeAll(v); }
export function getSecret(person, k) { return readAll().secrets?.[who(person)]?.[k] ?? null; }
export function listSecrets(person) { return Object.keys(readAll().secrets?.[who(person)] || {}); }

// Logins are keyed by site: "https://www.eventer.co.il/login" and "Eventer" both become "eventer.co.il" / "eventer".
export const siteKey = s => String(s).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
export function setLogin(person, site, login) {
  const v = readAll();
  ((v.logins ||= {})[who(person)] ||= {})[siteKey(site)] = { ...login, savedAt: new Date().toISOString().slice(0, 10) };
  writeAll(v);
}
export function getLogin(person, site) {
  const mine = readAll().logins?.[who(person)] || {};
  const k = siteKey(site);
  const hit = Object.keys(mine).find(s => s === k || s.includes(k) || k.includes(s)); // "eventer" finds "eventer.co.il"
  return hit ? { site: hit, ...mine[hit] } : null;
}
export function listLogins(person) {
  return Object.entries(readAll().logins?.[who(person)] || {}).map(([site, l]) => ({ site, username: l.username, agent: !!l.agent }));
}

// Time-based one-time code from an authenticator secret (RFC 6238), so the agent can pass two-factor prompts.
export function totp(secret, at = Date.now()) {
  const s = String(secret).toUpperCase().replace(/[^A-Z2-7]/g, "");
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "", bytes = [];
  for (const c of s) bits += A.indexOf(c).toString(2).padStart(5, "0");
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}

// Everything stored for a person, names only, for the vault page.
export function overview(person) {
  const v = readAll();
  const isOwner = ["owner", process.env.OWNER_NAME || "owner"].map(s => s.toLowerCase()).includes(who(person));
  return {
    card: isOwner && v.card ? { masked: mask(v.card.number), name: v.card.name, exp: v.card.exp } : null,
    secrets: Object.keys(v.secrets?.[who(person)] || {}),
    logins: Object.entries(v.logins?.[who(person)] || {}).map(([site, l]) => ({ site, username: l.username, totp: !!l.totp, agent: !!l.agent, savedAt: l.savedAt }))
  };
}
export function removeCard() { const v = readAll(); delete v.card; writeAll(v); }
export function removeSecret(person, k) { const v = readAll(); delete v.secrets?.[who(person)]?.[k]; writeAll(v); }
export function removeLogin(person, site) { const v = readAll(); delete v.logins?.[who(person)]?.[siteKey(site)]; writeAll(v); }

export function luhn(n) {
  let s = 0, alt = false;
  for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } s += d; alt = !alt; }
  return n.length >= 12 && n.length <= 19 && s % 10 === 0;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  const v = readAll();
  if (cmd === "show") {
    console.log("card:", v.card ? `${mask(v.card.number)} · exp ${v.card.exp} · ${v.card.name}` : "none");
    for (const [p, s] of Object.entries(v.secrets || {})) if (Object.keys(s).length) console.log(`${p}: ${Object.keys(s).join(", ")}`);
    for (const [p, l] of Object.entries(v.logins || {})) for (const [site, x] of Object.entries(l)) console.log(`${p}: login ${site} (${x.username}${x.totp ? ", +authenticator" : ""}${x.agent ? ", agent item" : ""})`);
  } else if (cmd === "remove-card") { delete v.card; writeAll(v); console.log("Card removed."); }
  else if (cmd === "remove" && a && b) { delete v.secrets?.[who(a)]?.[b]; writeAll(v); console.log(`Removed ${b} for ${a}.`); }
  else if (cmd === "remove-login" && a && b) { delete v.logins?.[who(a)]?.[siteKey(b)]; writeAll(v); console.log(`Removed login ${siteKey(b)} for ${a}.`); }
  else if (cmd === "wipe") { rmSync(FILE, { force: true }); console.log("Vault wiped."); }
  else console.log("Usage: node vault.mjs show | remove-card | remove <person> <key> | remove-login <person> <site> | wipe");
}
