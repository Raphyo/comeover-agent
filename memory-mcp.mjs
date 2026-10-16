// Memory tools for the agent: who people are and what they like, kept in memory.json next to the bot.
//   memory_set  { who, field, value }  a profile field: phone, email, city, area, diet, budget, free_evenings, language, kids, ...
//   memory_note { who, fact }          a free-form fact (tastes, no-gos, how they liked a place)
//   memory_get  { who? }               everything known about one person, or about everyone
// bot.mjs reads the same file to brief the agent at the start of every turn.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FILE = path.join(process.env.DATA_DIR || path.dirname(fileURLToPath(import.meta.url)), "memory.json");
const load = () => { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return { people: {} }; } };
const save = m => writeFileSync(FILE, JSON.stringify(m, null, 2));
const clean = who => String(who).trim().replace(/\s*\(owner\)$/i, "");
const key = who => clean(who).toLowerCase();
const text = t => ({ content: [{ type: "text", text: t }] });
const person = (m, who) => {
  const p = (m.people[key(who)] ||= { name: clean(who) });
  p.profile ||= {}; p.notes ||= []; // entries written before profiles existed
  return p;
};

// One line about a person for the agent's briefing, or null if nothing is known.
export function describe(name) {
  const p = load().people[key(name)];
  if (!p) return null;
  const fields = Object.entries(p.profile || {}).map(([k, v]) => `${k} ${v}`);
  const notes = (p.notes || []).slice(-6).map(n => n.fact);
  if (!fields.length && !notes.length) return null;
  return `${p.name}: ` + [...fields, ...notes].join("; ");
}

// Used by bot.mjs to seed what it knows from configuration (the owner's phone).
export function setField(name, field, value) {
  const m = load();
  person(m, name).profile[field] = value;
  save(m);
}

const server = new McpServer({ name: "memory", version: "0.2.0" });

server.registerTool("memory_set", {
  description: "Save a profile field for a person: phone, email, city, area (neighbourhood), diet, budget, free_evenings, language, kids, or another short key. Call it the moment someone gives you such a detail, so you never ask twice. Never store card numbers, codes or anything secret.",
  inputSchema: { who: z.string().describe("Name as shown in the chat"), field: z.string().describe("phone, email, city, area, diet, budget, free_evenings, language, kids, ..."), value: z.string() }
}, async ({ who, field, value }) => {
  const m = load();
  const p = person(m, who);
  p.profile[field.trim().toLowerCase().replace(/\s+/g, "_")] = value.trim();
  save(m);
  return text(`Saved for ${p.name}: ${field} = ${value.trim()}`);
});

server.registerTool("memory_note", {
  description: "Remember one free-form fact about a person: a taste, a no-go, how they liked a place, who they usually come with. Use the name as it appears in the chat.",
  inputSchema: { who: z.string(), fact: z.string() }
}, async ({ who, fact }) => {
  const m = load();
  const p = person(m, who);
  p.notes.push({ at: new Date().toISOString().slice(0, 10), fact: fact.trim() });
  if (p.notes.length > 50) p.notes.splice(0, p.notes.length - 50);
  save(m);
  return text(`Noted about ${p.name}: ${fact.trim()}`);
});

server.registerTool("memory_get", {
  description: "Everything known about one person (by name) or, with no name, about everyone: profile fields and dated notes.",
  inputSchema: { who: z.string().optional() }
}, async ({ who }) => {
  const m = load();
  const people = who ? [m.people[key(who)]].filter(Boolean) : Object.values(m.people);
  if (!people.length) return text(who ? `Nothing known about ${who} yet.` : "Nothing known about anyone yet.");
  return text(people.map(p => `${p.name}\n` +
    Object.entries(p.profile || {}).map(([k, v]) => `  ${k}: ${v}`).join("\n") + (Object.keys(p.profile || {}).length ? "\n" : "") +
    (p.notes || []).map(n => `  ${n.at} ${n.fact}`).join("\n")).join("\n"));
});

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await server.connect(new StdioServerTransport());
