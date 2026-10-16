// Judgement call for idle groups: is this message for Come Over? A small, fast model reads the last few lines and
// answers YES or NO. Hard triggers (a mention, a reply to the bot, "come over" in the text) never reach here.
//   await shouldStepIn(lines) -> boolean
import { spawn } from "node:child_process";
import { agentEnv } from "./brain.mjs";

const PROMPT = `You decide whether "Come Over", an assistant that lives in a WhatsApp group of friends and finds dates, suggests places and books tables, should step in now. Answer with one word: YES or NO.
YES when the newest message is addressed to it (even without naming it), asks it something, asks the group to plan a meetup, dinner, drinks or an outing it could organise, or gives information it needs (a date, a place, an email, a yes or no to a plan).
NO for ordinary chat between friends, jokes, news, questions to other people, logistics it was not asked about, or anything unrelated. When unsure, NO.`;

export function shouldStepIn(lines, { model = process.env.CLASSIFIER_MODEL || "haiku", timeoutMs = 20000 } = {}) {
  return new Promise(resolve => {
    const env = agentEnv();
    const p = spawn("claude", [
      "-p", "--model", model, "--tools", "", "--setting-sources", "project",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--system-prompt", PROMPT, "--output-format", "text"
    ], { env, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { p.kill("SIGKILL"); resolve(false); }, timeoutMs);
    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.on("close", () => { clearTimeout(timer); resolve(/^\s*yes/i.test(out)); });
    p.on("error", () => { clearTimeout(timer); resolve(false); });
    p.stdin.end("Recent messages, newest last:\n" + lines.join("\n"));
  });
}
