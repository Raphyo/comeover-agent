// The web vault: a private one-time link where the person types something sensitive on their phone: a card, or any
// identifier the agent asks for (ID number, passport...). Served by bot.mjs, published over HTTPS through a Cloudflare
// quick tunnel (falls back to the LAN address).
//
//   const vault = await startVaultWeb({ port, onSaved(chatId, info), onIssued(spec, url) })
//   vault.issue(spec) -> url     // spec: { chatId, who, kind: "card" | "secret", title, subtitle?, fields? }
//                                // fields (kind secret): [{ key, label, secret?, placeholder?, inputmode? }]
//   onSaved gets { kind: "card", who, masked } or { kind: "secret", who, keys }
//   onIssued may deliver the link privately and return true; then the agent is told not to paste it
//
// Localhost-only API used by card-mcp.mjs:  POST /issue <spec> -> { url, delivered }
import http from "node:http";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { saveCard, setSecret, setLogin, siteKey, mask, luhn, overview, removeCard, removeSecret, removeLogin } from "./vault.mjs";

const TTL_MS = 15 * 60 * 1000;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function lanIp() {
  for (const list of Object.values(networkInterfaces())) for (const i of list) if (i.family === "IPv4" && !i.internal) return i.address;
  return "localhost";
}

// A quick tunnel gives a random https://*.trycloudflare.com address, no account needed.
function openTunnel(port) {
  return new Promise(async resolve => {
    if (process.env.NO_TUNNEL) return resolve(null);
    let bin;
    try { bin = (await import("cloudflared")).bin; } catch { return resolve(null); }
    const p = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => resolve(null), 25000);
    const look = d => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(timer); resolve(m[0]); } };
    p.stdout.on("data", look); p.stderr.on("data", look);
    p.on("exit", () => { clearTimeout(timer); resolve(null); });
    process.on("exit", () => p.kill());
  });
}

const STYLE = `
  body { margin: 0; background: #fff; color: #111; font: 15px/1.4 -apple-system, system-ui, sans-serif; }
  main { max-width: 360px; margin: 0 auto; padding: 56px 20px 40px; }
  .lock { width: 44px; height: 44px; border-radius: 12px; background: #111; margin: 0 auto 22px; display: grid; place-items: center; }
  h1 { font-size: 24px; font-weight: 500; text-align: center; margin: 0 0 8px; }
  .sub { text-align: center; color: #6b6b6b; margin: 0 0 32px; }
  label { display: block; font-size: 13px; color: #444; margin: 0 0 6px; }
  .row { margin-bottom: 18px; position: relative; }
  input { width: 100%; box-sizing: border-box; font: 17px -apple-system, system-ui, sans-serif; padding: 11px 12px; border: 1px solid #ddd; border-radius: 6px; background: #fff; color: #111; }
  input:focus { outline: none; border-color: #111; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .eye { position: absolute; right: 10px; bottom: 9px; border: 0; background: none; color: #888; font-size: 13px; cursor: pointer; padding: 4px; }
  button.save { width: 100%; border: 0; border-radius: 999px; background: #111; color: #fff; font: 500 16px -apple-system, system-ui, sans-serif; padding: 15px; margin-top: 8px; cursor: pointer; }
  button.save:disabled { opacity: .5; }
  .err { color: #b3261e; font-size: 13px; min-height: 1.3em; margin: 8px 0 0; }
  .fine { color: #8a8a8a; font-size: 12px; text-align: center; margin-top: 18px; }
  .done { text-align: center; display: none; }
  .done h1 { margin-top: 0; }`;

const LOCK = `<div class="lock"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div>`;

const CARD_FIELDS = `
    <div class="row"><label for="num">Card number</label><input id="num" name="number" inputmode="numeric" autocomplete="cc-number" required><button type="button" class="eye" data-for="num">show</button></div>
    <div class="two">
      <div class="row"><label for="mm">Expiry month</label><input id="mm" name="mm" inputmode="numeric" autocomplete="cc-exp-month" placeholder="MM" maxlength="2" required></div>
      <div class="row"><label for="yy">Expiry year</label><input id="yy" name="yy" inputmode="numeric" autocomplete="cc-exp-year" placeholder="YY" maxlength="4" required></div>
    </div>
    <div class="row"><label for="cvc">CVV</label><input id="cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" type="password" maxlength="4" required><button type="button" class="eye" data-for="cvc">show</button></div>
    <div class="row"><label for="name">Name on card</label><input id="name" name="name" autocomplete="cc-name" required></div>`;

const LOGIN_FIELDS = `
    <div class="row"><label for="u">Username or email</label><input id="u" name="username" autocomplete="username" required></div>
    <div class="row"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required><button type="button" class="eye" data-for="p">show</button></div>
    <div class="row"><label for="t">Authenticator secret (optional)</label><input id="t" name="totp" type="password" autocomplete="off" placeholder="If the site uses a 6-digit code app"><button type="button" class="eye" data-for="t">show</button></div>`;

const secretFields = fields => fields.map((f, i) => `
    <div class="row"><label for="f${i}">${esc(f.label || f.key)}</label><input id="f${i}" name="${esc(f.key)}" ${f.secret === false ? "" : 'type="password"'} ${f.inputmode ? `inputmode="${esc(f.inputmode)}"` : ""} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""} autocomplete="off" required>${f.secret === false ? "" : `<button type="button" class="eye" data-for="f${i}">show</button>`}</div>`).join("");

const page = spec => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title)}</title>
<style>${STYLE}</style>
<main>
  ${LOCK}
  <form id="f">
    <h1>${esc(spec.title)}</h1>
    <p class="sub">${esc(spec.subtitle || "Give Come Over access to this.")}</p>
    ${spec.kind === "card" ? CARD_FIELDS : spec.kind === "login" ? LOGIN_FIELDS : secretFields(spec.fields)}
    <button class="save" type="submit">Save to vault &nbsp;→</button>
    <p class="err" id="err"></p>
    <p class="fine">Stored encrypted on the device that runs Come Over. Used only for what you approve in the chat, and never shown there.</p>
  </form>
  <div class="done" id="done"><h1>Saved</h1><p class="sub" id="donemsg"></p><p class="fine">You can close this page and go back to WhatsApp.</p></div>
</main>
<script>
  var num = document.getElementById("num");
  if (num) num.addEventListener("input", function () { var d = num.value.replace(/\\D/g, "").slice(0, 19); num.value = d.replace(/(.{4})/g, "$1 ").trim(); });
  document.querySelectorAll(".eye").forEach(function (b) { b.onclick = function () { var i = document.getElementById(b.dataset.for); var hide = i.type !== "password"; i.type = hide ? "password" : "text"; b.textContent = hide ? "show" : "hide"; }; });
  document.getElementById("f").onsubmit = async function (e) {
    e.preventDefault();
    var btn = document.querySelector(".save"), err = document.getElementById("err");
    btn.disabled = true; err.textContent = "";
    var body = {};
    document.querySelectorAll("#f input").forEach(function (i) { body[i.name] = i.value; });
    if (body.number) body.number = body.number.replace(/\\D/g, "");
    try {
      var r = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save");
      document.getElementById("f").style.display = "none";
      document.getElementById("donemsg").textContent = j.message;
      document.getElementById("done").style.display = "block";
    } catch (x) { err.textContent = x.message; btn.disabled = false; }
  };
</script>`;

// The vault page: everything a person has stored, names only, with add and remove. Valid 15 minutes, reusable within that.
const overviewPage = (token, who, o) => {
  const row = (title, sub, kind, key) => `<div class="item"><div><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div><button type="button" class="rm" data-kind="${kind}" data-key="${esc(key)}" data-name="${esc(title)}">Remove</button></div>`;
  const empty = t => `<p class="empty">${t}</p>`;
  const mine = o.logins.filter(l => !l.agent), agent = o.logins.filter(l => l.agent);
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your vault</title>
<style>${STYLE}
  main { max-width: 420px; padding-top: 40px; }
  h1.brand { font-family: Georgia, "Times New Roman", serif; font-weight: 400; font-size: 28px; margin: 0 0 34px; text-align: center; }
  section { margin: 0 0 40px; }
  .head { display: flex; align-items: center; justify-content: space-between; border-bottom: 1.5px solid #111; padding-bottom: 10px; margin-bottom: 14px; }
  h2 { font-family: Georgia, "Times New Roman", serif; font-weight: 400; font-size: 24px; margin: 0; }
  .add { border: 0; background: none; font-size: 26px; line-height: 1; cursor: pointer; padding: 0 4px; color: #111; }
  .item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; }
  .t { font-size: 15px; } .s { color: #6b6b6b; font-size: 13px; margin-top: 2px; }
  .rm { border: 1px solid #ddd; background: #fff; border-radius: 999px; font-size: 12px; padding: 6px 10px; color: #444; cursor: pointer; }
  .empty { color: #8a8a8a; margin: 0; }
  .addform { display: none; gap: 8px; margin: 6px 0 10px; }
  .addform.open { display: flex; }
  .addform input { flex: 1; padding: 9px 11px; font-size: 15px; }
  .addform button { border: 0; background: #111; color: #fff; border-radius: 999px; padding: 0 14px; font-size: 14px; cursor: pointer; }
  .desc { color: #6b6b6b; font-size: 14px; margin: 0 0 10px; }
</style>
<main>
  <h1 class="brand">Come Over</h1>
  <section>
    <div class="head"><h2>Logins</h2><button type="button" class="add" data-open="login" aria-label="Add login">+</button></div>
    <form class="addform" id="add-login"><input name="site" placeholder="Site, e.g. eventer.co.il" required><button type="submit">Add</button></form>
    ${mine.length ? mine.map(l => row(l.site, l.username + (l.totp ? " · authenticator" : ""), "login", l.site)).join("") : empty("No logins saved")}
  </section>
  <section>
    <div class="head"><h2>Cards</h2>${o.card ? "" : '<button type="button" class="add" data-add="card" aria-label="Add card">+</button>'}</div>
    ${o.card ? row("Main card " + o.card.masked, o.card.name + " · exp " + o.card.exp, "card", "card") : empty("No cards saved")}
  </section>
  <section>
    <div class="head"><h2>Personal info</h2><button type="button" class="add" data-open="secret" aria-label="Add personal info">+</button></div>
    <form class="addform" id="add-secret"><input name="label" placeholder="What is it, e.g. Israeli ID number" required><button type="submit">Add</button></form>
    ${o.secrets.length ? o.secrets.map(k => row(k.replace(/_/g, " "), "", "secret", k)).join("") : empty("Nothing saved")}
  </section>
  <section>
    <div class="head"><h2>Agent items (${agent.length})</h2></div>
    <p class="desc">Accounts the agent created for you. They stay in your vault and remain under your control.</p>
    ${agent.length ? agent.map(l => row(l.site, l.username, "login", l.site)).join("") : ""}
  </section>
  <p class="fine">Stored encrypted on the device that runs Come Over. The agent only ever sees the names of these items.</p>
</main>
<script>
  var post = function (body) { return fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }); };
  document.querySelectorAll(".rm").forEach(function (b) { b.onclick = function () { if (!confirm("Remove " + b.dataset.name + " from the vault?")) return; post({ action: "remove", kind: b.dataset.kind, key: b.dataset.key }).then(function () { location.reload(); }); }; });
  document.querySelectorAll(".add[data-open]").forEach(function (b) { b.onclick = function () { document.getElementById("add-" + b.dataset.open).classList.toggle("open"); }; });
  document.querySelectorAll(".add[data-add]").forEach(function (b) { b.onclick = function () { post({ action: "add", kind: b.dataset.add }).then(function (j) { if (j.url) location.href = j.url; }); }; });
  document.querySelectorAll(".addform").forEach(function (f) { f.onsubmit = function (e) { e.preventDefault(); var i = f.querySelector("input"); post({ action: "add", kind: f.id.slice(4), value: i.value }).then(function (j) { if (j.url) location.href = j.url; else alert(j.error || "Could not add"); }); }; });
</script>`;
};

const expired = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link expired</title>
<main style="max-width:360px;margin:0 auto;padding:80px 20px;font:15px/1.5 -apple-system,system-ui,sans-serif;text-align:center;color:#111"><h1 style="font-weight:500">This link has expired</h1><p style="color:#6b6b6b">Ask Come Over for a new one in the chat.</p></main>`;

export async function startVaultWeb({ port = 8787, onSaved = () => {}, onIssued = async () => false, status = () => "" } = {}) {
  const tokens = new Map(); // token -> { spec, expires, used }
  let baseUrl = process.env.PUBLIC_URL || `http://${lanIp()}:${port}`;

  const readJson = req => new Promise((res, rej) => { let b = ""; req.on("data", d => { b += d; if (b.length > 1e5) req.destroy(); }); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { rej(new Error("bad json")); } }); });
  const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  const local = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

  function normalize(s) {
    const spec = { chatId: String(s.chatId || ""), who: String(s.who || "owner").trim(), kind: ["card", "login", "overview"].includes(s.kind) ? s.kind : "secret", title: String(s.title || "").slice(0, 80), subtitle: String(s.subtitle || "").slice(0, 160) };
    if (spec.kind === "overview") { spec.title = "your vault"; return spec; }
    if (spec.kind === "card") { spec.title ||= "Main card"; spec.subtitle ||= "Give Come Over access to this card."; }
    else if (spec.kind === "login") {
      spec.site = siteKey(s.site || "");
      if (!spec.site) throw new Error("site required");
      spec.title ||= `${spec.site} login`; spec.subtitle ||= `Give Come Over access to your ${spec.site} account.`;
    } else {
      spec.fields = (Array.isArray(s.fields) ? s.fields : []).slice(0, 5).map(f => ({
        key: String(f.key || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40), label: String(f.label || f.key || "").slice(0, 60),
        secret: f.secret !== false, placeholder: f.placeholder ? String(f.placeholder).slice(0, 40) : "", inputmode: /^(numeric|tel|email|text)$/.test(f.inputmode) ? f.inputmode : ""
      })).filter(f => f.key);
      if (!spec.fields.length) throw new Error("fields required");
      spec.title ||= spec.fields[0].label;
    }
    return spec;
  }

  function issue(spec) {
    const token = randomBytes(18).toString("base64url");
    tokens.set(token, { spec, expires: Date.now() + TTL_MS, used: false });
    for (const [k, v] of tokens) if (v.used || Date.now() > v.expires) tokens.delete(k);
    console.log(`[vault] link issued: ${spec.kind} "${spec.title}" for ${spec.who} (${spec.chatId || "no chat"})`);
    return `${baseUrl}/v/${token}`;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const m = url.pathname.match(/^\/v\/([A-Za-z0-9_-]{20,})$/);
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, baseUrl });
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, { ok: true, status: status() });
      if (req.method === "POST" && url.pathname === "/chat") { await readJson(req).catch(() => ({})); return send(res, 200, { response: status() }); }
      if (req.method === "POST" && url.pathname === "/issue") {
        if (!local(req)) return send(res, 403, { error: "local only" });
        const spec = normalize(await readJson(req));
        const link = issue(spec);
        let delivered = false;
        try { delivered = !!(await onIssued(spec, link)); } catch {}
        return send(res, 200, { url: link, delivered });
      }
      if (m) {
        const t = tokens.get(m[1]);
        if (!t || t.used || Date.now() > t.expires) return send(res, 410, expired, "text/html");
        if (t.spec.kind === "overview") {
          // The vault page stays usable until it expires; its add buttons hand out one-time add pages.
          if (req.method === "GET") return send(res, 200, overviewPage(m[1], t.spec.who, overview(t.spec.who)), "text/html");
          const b = await readJson(req);
          if (b.action === "remove") {
            if (b.kind === "card") removeCard(); else if (b.kind === "login") removeLogin(t.spec.who, b.key); else if (b.kind === "secret") removeSecret(t.spec.who, String(b.key));
            console.log(`[vault] ${t.spec.who} removed ${b.kind} ${b.kind === "card" ? "" : b.key} from the vault page`);
            return send(res, 200, { ok: true });
          }
          if (b.action === "add") {
            let spec;
            if (b.kind === "card") spec = normalize({ chatId: t.spec.chatId, who: t.spec.who, kind: "card" });
            else if (b.kind === "login") spec = normalize({ chatId: t.spec.chatId, who: t.spec.who, kind: "login", site: b.value });
            else spec = normalize({ chatId: t.spec.chatId, who: t.spec.who, kind: "secret", title: b.value, fields: [{ key: String(b.value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label: b.value }] });
            return send(res, 200, { url: issue(spec) });
          }
          return send(res, 400, { error: "unknown action" });
        }
        if (req.method === "GET") return send(res, 200, page(t.spec), "text/html");
        if (req.method === "POST") {
          const b = await readJson(req);
          let message, info;
          if (t.spec.kind === "card") {
            const number = String(b.number || "").replace(/\D/g, "");
            const mm = String(b.mm || "").padStart(2, "0"), yy = String(b.yy || "").slice(-2);
            const cvc = String(b.cvc || "").replace(/\D/g, ""), name = String(b.name || "").trim().slice(0, 60);
            if (!luhn(number)) return send(res, 400, { error: "That card number doesn't look right." });
            if (!/^(0[1-9]|1[0-2])$/.test(mm) || !/^\d{2}$/.test(yy)) return send(res, 400, { error: "Check the expiry date." });
            if (cvc.length < 3 || cvc.length > 4) return send(res, 400, { error: "The CVV should be 3 or 4 digits." });
            if (!name) return send(res, 400, { error: "Add the name on the card." });
            saveCard({ number, exp: `${mm}/${yy}`, cvc, name });
            message = `Card ${mask(number)} is in the vault.`;
            info = { kind: "card", who: t.spec.who, masked: mask(number) };
          } else if (t.spec.kind === "login") {
            const username = String(b.username || "").trim().slice(0, 120), password = String(b.password || ""), totpSecret = String(b.totp || "").replace(/\s/g, "");
            if (!username) return send(res, 400, { error: "Add the username or email." });
            if (!password) return send(res, 400, { error: "Add the password." });
            setLogin(t.spec.who, t.spec.site, { username, password, ...(totpSecret ? { totp: totpSecret } : {}) });
            message = `Your ${t.spec.site} login is in the vault.`;
            info = { kind: "login", who: t.spec.who, site: t.spec.site, title: t.spec.title };
          } else {
            const keys = [];
            for (const f of t.spec.fields) {
              const v = String(b[f.key] || "").trim();
              if (!v) return send(res, 400, { error: `Add ${f.label}.` });
              setSecret(t.spec.who, f.key, v);
              keys.push(f.key);
            }
            message = `${t.spec.title} is in the vault.`;
            info = { kind: "secret", who: t.spec.who, keys, title: t.spec.title };
          }
          t.used = true;
          send(res, 200, { ok: true, message });
          try { onSaved(t.spec.chatId, info); } catch {}
          return;
        }
      }
      send(res, 404, "Not found", "text/plain");
    } catch (e) { send(res, 400, { error: e.message }); }
  });

  await new Promise(r => server.listen(port, r));
  if (!process.env.PUBLIC_URL) {
    const tunnel = await openTunnel(port);
    if (tunnel) baseUrl = tunnel; else console.log("[vault] no tunnel; links use the LAN address (same Wi-Fi only, not HTTPS)");
  }
  console.log(`[vault] links at ${baseUrl}/v/...`);
  return { issue, get baseUrl() { return baseUrl; }, close: () => server.close() };
}
