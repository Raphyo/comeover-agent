// Vault tools for the agent. Sensitive values never pass through the model: this process reads the vault and types
// into the shared browser itself. Every use is logged to payments.log / vault.log, values excluded.
//   card_status                   is a card saved, last four digits, today's spend, the caps
//   card_link                     private one-time page where the owner adds a card
//   fill_card { amount, ... }     types the card into the payment form (capped, logged, screenshot)
//   vault_status { who }          which sensitive details are stored for a person (names only)
//   vault_link { who, title, fields }   private one-time page for any sensitive detail (ID number, passport...)
//   vault_fill { who, key, field }      types a stored detail into a form field
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readCard, mask, getSecret, listSecrets, getLogin, listLogins, setLogin, totp } from "./vault.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CDP = process.env.CDP_ENDPOINT || "http://localhost:9222";
const VAULT = `http://localhost:${process.env.VAULT_PORT || 8787}`;
const CAP = Number(process.env.CARD_CAP || 150);
const DAILY = Number(process.env.CARD_DAILY_CAP || 300);
const DATA = process.env.DATA_DIR || HERE;
const LOG = path.join(DATA, "payments.log");
const VLOG = path.join(DATA, "vault.log");
const CHAT = process.env.COMEOVER_CHAT || "";

const text = t => ({ content: [{ type: "text", text: t }] });
const fail = t => ({ content: [{ type: "text", text: t }], isError: true });

function spentToday() {
  if (!existsSync(LOG)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  return readFileSync(LOG, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.at.startsWith(today)).reduce((s, e) => s + e.amount, 0);
}

// The open tabs, most likely working tab first: focused, then visible, newest first; blank and internal tabs last.
// The fill tools then take the first tab that actually has the field they need.
async function orderedPages() {
  const browser = await chromium.connectOverCDP(CDP);
  const scored = [];
  for (const [i, p] of browser.contexts().flatMap(c => c.pages()).entries()) {
    let score = /^(about:|chrome:|devtools:)/.test(p.url()) ? -10 : 0;
    try { score += await p.evaluate(() => (document.hasFocus() ? 2 : 0) + (document.visibilityState === "visible" ? 1 : 0)); } catch {}
    scored.push({ p, score, i });
  }
  if (!scored.length) throw new Error("no page open");
  return { browser, pages: scored.sort((a, b) => b.score - a.score || b.i - a.i).map(s => s.p) };
}

const SEL = {
  number: ['input[autocomplete="cc-number"]', 'input[name*="cardnumber" i]', 'input[name*="card_number" i]', 'input[name*="ccnumber" i]', 'input[id*="cardnumber" i]', 'input[id*="card-number" i]', 'input[name*="pan" i]', 'input[placeholder*="card number" i]', 'input[placeholder*="מספר כרטיס"]', 'input[aria-label*="card number" i]'],
  exp: ['input[autocomplete="cc-exp"]', 'input[name*="expiry" i]', 'input[name*="expir" i]', 'input[id*="expir" i]', 'input[placeholder*="MM" i]', 'input[placeholder*="תוקף"]'],
  month: ['select[autocomplete="cc-exp-month"]', 'input[autocomplete="cc-exp-month"]', 'select[name*="month" i]', 'input[name*="month" i]', 'select[id*="month" i]'],
  year: ['select[autocomplete="cc-exp-year"]', 'input[autocomplete="cc-exp-year"]', 'select[name*="year" i]', 'input[name*="year" i]', 'select[id*="year" i]'],
  cvc: ['input[autocomplete="cc-csc"]', 'input[name*="cvv" i]', 'input[name*="cvc" i]', 'input[name*="csc" i]', 'input[id*="cvv" i]', 'input[id*="cvc" i]', 'input[placeholder*="cvv" i]', 'input[placeholder*="cvc" i]'],
  name: ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]', 'input[name*="holder" i]', 'input[id*="holder" i]', 'input[placeholder*="name on card" i]', 'input[placeholder*="שם בעל הכרטיס"]']
};

async function find(page, selectors) {
  for (const frame of page.frames()) {
    for (const s of selectors) {
      const loc = frame.locator(s).first();
      try { if ((await loc.count()) && (await loc.isVisible())) return loc; } catch {}
    }
  }
  return null;
}
// A field by what the person sees: its label, placeholder, aria-label, name or id (substring, case-insensitive).
async function findByHint(page, hint) {
  const h = String(hint).replace(/["\\]/g, "");
  for (const frame of page.frames()) {
    const candidates = [
      frame.getByLabel(hint), frame.getByPlaceholder(hint),
      frame.locator(`input[aria-label*="${h}" i], input[name*="${h}" i], input[id*="${h}" i], textarea[name*="${h}" i]`)
    ];
    for (const c of candidates) {
      try { const loc = c.first(); if ((await loc.count()) && (await loc.isVisible())) return loc; } catch {}
    }
  }
  return null;
}
async function typeInto(loc, value) {
  await loc.click();
  try { await loc.fill(""); } catch {}
  if (loc.pressSequentially) await loc.pressSequentially(value, { delay: 40 }); else await loc.type(value, { delay: 40 });
}
async function choose(loc, options) {
  const tag = await loc.evaluate(e => e.tagName.toLowerCase());
  if (tag === "select") {
    for (const o of options) { try { await loc.selectOption(o); return true; } catch {} try { await loc.selectOption({ label: o }); return true; } catch {} }
    return false;
  }
  await typeInto(loc, options[0]);
  return true;
}
async function requestLink(spec) {
  const r = await fetch(`${VAULT}/issue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: CHAT, ...spec }) });
  if (!r.ok) throw new Error("vault server answered " + r.status);
  return r.json();
}
const linkAnswer = (who, what, { url, delivered }) => delivered
  ? `A private link to ${what} was sent to ${who} in a direct message. Do not paste it here; tell ${who} to check their private chat with you${what === "their vault" ? "." : ", then wait for the system note saying it was saved."}`
  : `Send this to ${who}: ${url}\nIt is private and valid 15 minutes.${what === "their vault" ? "" : " Wait for the system note saying it was saved."}`;

const server = new McpServer({ name: "card", version: "0.3.0" });

server.registerTool("card_status", {
  description: "Whether the owner has a saved card, its last four digits, what has been spent today and the spending caps. Call this before offering to pay."
}, async () => {
  const c = readCard();
  return text(c
    ? `Saved card ${mask(c.number)} (${c.name}). Spent today: ${spentToday()}. Caps: ${CAP} per payment, ${DAILY} per day.`
    : "No card saved. Call card_link to get a private link the owner can use to add one.");
});

server.registerTool("card_link", {
  description: "Creates a private one-time page (valid 15 minutes) where the owner types their card, encrypted into the vault. Never ask for card details in the chat. You get a system note once the card is saved."
}, async () => {
  try { return text(linkAnswer("the owner", "add their card", await requestLink({ kind: "card", who: "owner" }))); }
  catch (e) { return fail("Could not create a link: " + (e?.message || e) + ". Tell the person the vault is unavailable right now."); }
});

server.registerTool("fill_card", {
  description: "Types the owner's saved card into the payment form currently open in the browser (card number, expiry, CVC, cardholder name), including forms inside iframes. Only call this after the owner has explicitly said yes to this exact payment in the chat. It does not click Pay: review the form and submit it yourself afterwards. The amount is checked against the caps and the use is logged.",
  inputSchema: {
    amount: z.number().describe("Amount about to be charged or held"),
    currency: z.string().describe("Currency code, e.g. ILS or EUR"),
    merchant: z.string().describe("Who is charging, e.g. the restaurant or ticket seller"),
    approved_by_user: z.boolean().describe("True only if the owner said yes to this payment in the chat")
  }
}, async ({ amount, currency, merchant, approved_by_user }) => {
  if (!approved_by_user) return fail("Not filled: ask the owner first and call again with approved_by_user true.");
  const card = readCard();
  if (!card) return fail("Not filled: no card saved. Call card_link.");
  if (amount > CAP) return fail(`Not filled: ${amount} ${currency} is above the cap of ${CAP} per payment. Tell the owner; they can raise CARD_CAP.`);
  if (spentToday() + amount > DAILY) return fail(`Not filled: this would exceed the daily cap of ${DAILY} (${spentToday()} spent today).`);

  let browser;
  try {
    const got = await orderedPages();
    browser = got.browser;
    // The payment form is on whichever tab has a card-number field; the most likely tab is tried first.
    let page = got.pages[0], number = null;
    for (const p of got.pages) { number = await find(p, SEL.number); if (number) { page = p; break; } }
    const filled = [], missing = [];
    const [mm, yy] = card.exp.split("/");

    if (number) { await typeInto(number, card.number); filled.push("number"); } else missing.push("number");

    const exp = await find(page, SEL.exp);
    if (exp) {
      const max = await exp.getAttribute("maxlength");
      await typeInto(exp, max === "4" ? mm + yy : `${mm}/${yy}`); filled.push("expiry");
    } else {
      const month = await find(page, SEL.month), year = await find(page, SEL.year);
      if (month && year) { await choose(month, [mm, String(+mm)]); await choose(year, ["20" + yy, yy]); filled.push("expiry"); }
      else missing.push("expiry");
    }

    const cvc = await find(page, SEL.cvc);
    if (cvc) { await typeInto(cvc, card.cvc); filled.push("cvc"); } else missing.push("cvc");

    const name = await find(page, SEL.name);
    if (name) { await typeInto(name, card.name); filled.push("name"); }

    mkdirSync(path.join(DATA, "payments"), { recursive: true });
    const at = new Date().toISOString();
    const shot = path.join(DATA, "payments", at.replace(/[:.]/g, "-") + ".png");
    try { await page.screenshot({ path: shot }); } catch {}
    appendFileSync(LOG, JSON.stringify({ at, merchant, amount, currency, card: mask(card.number), filled, missing, url: page.url(), screenshot: shot }) + "\n");

    return text(missing.length === 0
      ? `Filled ${filled.join(", ")} with card ${mask(card.number)} for ${amount} ${currency} at ${merchant}. Check the form, fill any other field it asks for, then submit. If the bank asks for confirmation (3-D Secure), tell the owner to approve it in their banking app.`
      : `Partly filled (${filled.join(", ") || "nothing"}); could not find: ${missing.join(", ")}. Take a snapshot, tell the owner which fields are left, and do not guess.`);
  } catch (e) {
    return fail("Not filled: " + (e?.message || e) + ". Is the shared browser open on the payment page?");
  } finally {
    try { await browser?.close(); } catch {}
  }
});

server.registerTool("vault_page", {
  description: "Sends a person a private link to their vault page, where they see everything stored for them (card, logins, personal details, accounts you created) and can add or remove items. Use it whenever someone asks to see, check or manage their vault; do not list the contents in the chat.",
  inputSchema: { who: z.string().describe("Name as shown in the chat, or 'owner'") }
}, async ({ who }) => {
  try { return text(linkAnswer(who, "their vault", await requestLink({ kind: "overview", who }))); }
  catch (e) { return fail("Could not create a link: " + (e?.message || e) + ". Tell the person the vault is unavailable right now."); }
});

server.registerTool("vault_status", {
  description: "Which sensitive details are stored in the vault for a person (names of the details only, never the values), e.g. israeli_id, passport. The card is the owner's; see card_status.",
  inputSchema: { who: z.string().describe("Name as shown in the chat, or 'owner'") }
}, async ({ who }) => {
  const keys = listSecrets(who);
  return text(keys.length ? `Stored for ${who}: ${keys.join(", ")}.` : `Nothing stored for ${who}. Use vault_link to ask for it privately.`);
});

server.registerTool("vault_link", {
  description: "Asks a person for a sensitive detail (ID number, passport, date of birth, anything a form requires that should not be typed in a chat) through a private one-time page, like the card. Give a clear title saying what it is for. The value goes into the vault; you only get a system note that it was saved, then use vault_fill. Never ask for such details in the chat.",
  inputSchema: {
    who: z.string().describe("Name as shown in the chat, or 'owner'"),
    title: z.string().describe("What it is for, e.g. 'Israeli ID for concert tickets'"),
    fields: z.array(z.object({
      key: z.string().describe("Stable key, e.g. israeli_id, passport_number, date_of_birth"),
      label: z.string().describe("What the person sees, e.g. 'Israeli ID number'"),
      inputmode: z.enum(["numeric", "tel", "email", "text"]).optional()
    })).min(1).max(5)
  }
}, async ({ who, title, fields }) => {
  try { return text(linkAnswer(who, "add " + title, await requestLink({ kind: "secret", who, title, fields }))); }
  catch (e) { return fail("Could not create a link: " + (e?.message || e) + ". Tell the person the vault is unavailable right now."); }
});

server.registerTool("vault_fill", {
  description: "Types a stored sensitive detail (e.g. key israeli_id) of a person into one form field in the browser, without you seeing the value. Point at the field by what the page shows: its label, placeholder or name (e.g. 'ID number', 'תעודת זהות', 'passport'). Then check the form and continue.",
  inputSchema: {
    who: z.string().describe("Name as shown in the chat, or 'owner'"),
    key: z.string().describe("The stored key, e.g. israeli_id"),
    field: z.string().describe("Label, placeholder, name or id of the input, as shown on the page")
  }
}, async ({ who, key, field }) => {
  const value = getSecret(who, key);
  if (!value) return fail(`Nothing stored as ${key} for ${who}. Use vault_link to ask for it privately.`);
  let browser;
  try {
    const got = await orderedPages();
    browser = got.browser;
    let loc = null, page = null;
    for (const p of got.pages) { loc = await findByHint(p, field); if (loc) { page = p; break; } }
    if (!loc) return fail(`Could not find a field matching "${field}" on any open tab. Take a snapshot and try the exact label or placeholder.`);
    await typeInto(loc, value);
    appendFileSync(VLOG, JSON.stringify({ at: new Date().toISOString(), who, key, field, url: page.url() }) + "\n");
    return text(`Filled "${field}" with ${who}'s ${key}. Check the form and continue.`);
  } catch (e) {
    return fail("Not filled: " + (e?.message || e) + ". Is the shared browser open on the form?");
  } finally {
    try { await browser?.close(); } catch {}
  }
});

/* ---------- logins ---------- */

const USER_SEL = ['input[autocomplete="username"]', 'input[type="email"]', 'input[name*="email" i]', 'input[name*="user" i]', 'input[name*="login" i]', 'input[id*="email" i]', 'input[id*="user" i]', 'input[placeholder*="email" i]', 'input[placeholder*="user" i]', 'input[type="tel"]', 'input[name*="phone" i]'];
const PASS_SEL = ['input[type="password"]'];
const CODE_SEL = ['input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[name*="code" i]', 'input[id*="otp" i]', 'input[id*="code" i]', 'input[placeholder*="code" i]', 'input[inputmode="numeric"]'];

server.registerTool("login_status", {
  description: "Which site logins are stored in the vault for a person (site and username only, never the password).",
  inputSchema: { who: z.string().describe("Name as shown in the chat, or 'owner'") }
}, async ({ who }) => {
  const l = listLogins(who);
  return text(l.length ? `Logins for ${who}: ` + l.map(x => `${x.site} (${x.username}${x.agent ? ", created by you" : ""})`).join("; ") : `No logins stored for ${who}. Use login_link to ask for one privately.`);
});

server.registerTool("login_link", {
  description: "Asks a person for their login to a site (username, password, optional authenticator secret) through a private one-time page. Never ask for a password in the chat. You get a system note when it is saved, then use login_fill on the site's sign-in page.",
  inputSchema: { who: z.string().describe("Name as shown in the chat, or 'owner'"), site: z.string().describe("The site, e.g. eventer.co.il or ontopo.co.il"), title: z.string().optional().describe("What it is for, e.g. 'Eventer login for the tickets'") }
}, async ({ who, site, title }) => {
  try { return text(linkAnswer(who, `add their ${site} login`, await requestLink({ kind: "login", who, site, title: title || "" }))); }
  catch (e) { return fail("Could not create a link: " + (e?.message || e) + ". Tell the person the vault is unavailable right now."); }
});

server.registerTool("login_fill", {
  description: "Types a person's stored login into the sign-in form open in the browser: the username/email field and the password field it can find (sites that ask for the email first and the password on the next page need two calls). It does not click Sign in: do that yourself, then check the result. If the site then asks for a 6-digit code from an authenticator app, call login_code.",
  inputSchema: { who: z.string(), site: z.string().describe("The site, as stored (login_status lists them)"), username_field: z.string().optional().describe("Label or placeholder of the username field, if the usual ones are not found"), password_field: z.string().optional() }
}, async ({ who, site, username_field, password_field }) => {
  const login = getLogin(who, site);
  if (!login) return fail(`No login stored for ${who} at ${site}. Use login_link to ask for it privately.`);
  let browser;
  try {
    const got = await orderedPages();
    browser = got.browser;
    const filled = [];
    for (const p of got.pages) {
      const user = username_field ? await findByHint(p, username_field) : await find(p, USER_SEL);
      const pass = password_field ? await findByHint(p, password_field) : await find(p, PASS_SEL);
      if (!user && !pass) continue;
      if (user) { await typeInto(user, login.username); filled.push("username"); }
      if (pass) { await typeInto(pass, login.password); filled.push("password"); }
      appendFileSync(VLOG, JSON.stringify({ at: new Date().toISOString(), who, login: login.site, filled, url: p.url() }) + "\n");
      break;
    }
    if (!filled.length) return fail("No sign-in fields found on the open tabs. Open the site's login page first, or pass username_field / password_field with the labels you see.");
    return text(`Filled ${filled.join(" and ")} for ${who}'s ${login.site} account. Click Sign in and check the result.${filled.length === 1 && filled[0] === "username" ? " If a password field appears next, call login_fill again." : ""}`);
  } catch (e) {
    return fail("Not filled: " + (e?.message || e) + ". Is the shared browser open on the sign-in page?");
  } finally { try { await browser?.close(); } catch {} }
});

server.registerTool("login_code", {
  description: "Types the current 6-digit authenticator code for a stored login into the code field on the page (only works if the person saved the authenticator secret). You never see the code.",
  inputSchema: { who: z.string(), site: z.string(), code_field: z.string().optional().describe("Label or placeholder of the code field, if the usual ones are not found") }
}, async ({ who, site, code_field }) => {
  const login = getLogin(who, site);
  if (!login) return fail(`No login stored for ${who} at ${site}.`);
  if (!login.totp) return fail(`${who}'s ${login.site} login has no authenticator secret saved. Ask them for the code in the chat, or to add the secret via login_link.`);
  let browser;
  try {
    const got = await orderedPages();
    browser = got.browser;
    for (const p of got.pages) {
      const field = code_field ? await findByHint(p, code_field) : await find(p, CODE_SEL);
      if (!field) continue;
      await typeInto(field, totp(login.totp));
      appendFileSync(VLOG, JSON.stringify({ at: new Date().toISOString(), who, login: login.site, filled: ["code"], url: p.url() }) + "\n");
      return text("Typed the current authenticator code. Submit it and check the result.");
    }
    return fail("No code field found on the open tabs. Pass code_field with the label you see.");
  } catch (e) {
    return fail("Not filled: " + (e?.message || e));
  } finally { try { await browser?.close(); } catch {} }
});

server.registerTool("login_save", {
  description: "Stores a login that you created yourself for the person (an account you opened on a site to book or buy on their behalf). Generate a strong unique password and store it here right away; never write it in the chat. It is listed as an item created by you.",
  inputSchema: { who: z.string(), site: z.string(), username: z.string(), password: z.string().min(12) }
}, async ({ who, site, username, password }) => {
  setLogin(who, site, { username, password, agent: true });
  return text(`Stored ${who}'s ${site} login (${username}) as an account created by you.`);
});

await server.connect(new StdioServerTransport());
