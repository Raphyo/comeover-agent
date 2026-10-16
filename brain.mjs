// The agent: Claude Code headless, one `claude -p` call per turn, resumed by session id so each chat keeps its memory.
// Its only tool is a headed Chrome shared across turns (Playwright MCP), so a booking survives a question to the user.
// To change model or runtime (Agent SDK, Gemini, ...), replace this file and keep the contract:
//
//   const brain = createBrain({ dir, model? })
//   await brain.reply(chatId, text, onText)   // onText(text) fires for every message the agent wants to send
//   const browser = startBrowser(dir, port?)  // child process; kill it on exit
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The environment for `claude` runs. The agent uses the claude.ai login, so provider overrides that a shell profile
// may export (Bedrock, Vertex, model names) are dropped. Set KEEP_PROVIDER_ENV=1 to pass them through on purpose.
export function agentEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; // allow running from inside a Claude Code session
  if (!env.KEEP_PROVIDER_ENV) {
    for (const k of Object.keys(env)) {
      if (/^(CLAUDE_CODE_USE_|ANTHROPIC_MODEL$|ANTHROPIC_SMALL_FAST_MODEL$|ANTHROPIC_DEFAULT_|AWS_|ANTHROPIC_BEDROCK_|ANTHROPIC_VERTEX_|CLOUD_ML_REGION$)/.test(k)) delete env[k];
    }
  }
  return env;
}

// Newest Chromium build in Playwright's cache (installed by `npx playwright install chromium`); Google Chrome as a fallback.
function findChromium() {
  if (process.env.BROWSER_EXE) return process.env.BROWSER_EXE;
  const cache = process.platform === "darwin" ? path.join(homedir(), "Library", "Caches", "ms-playwright") : path.join(process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(homedir(), ".cache", "ms-playwright"));
  try {
    const builds = readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => +b.slice(9) - +a.slice(9));
    for (const b of builds) {
      for (const sub of readdirSync(path.join(cache, b))) {
        for (const app of ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "Chromium.app/Contents/MacOS/Chromium", "chrome", "chrome-linux/chrome", "headless_shell"]) {
          const p = path.join(cache, b, sub, app);
          if (existsSync(p)) return p;
        }
      }
    }
  } catch {}
  return process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "chromium";
}

// The browser is started here, with remote debugging on, so that both Playwright MCP (the agent's eyes and hands)
// and card-mcp.mjs (which types the card) drive the same window. The profile persists, so logins survive restarts.
// Playwright's own Chromium build is used: the installed Google Chrome is too new for this Playwright to attach to.
export async function startBrowser(dir, port = "8931", cdpPort = "9222") {
  // A browser from a previous run may still be up on the debugging port; attach to it rather than start a second one.
  let chrome = null;
  const alive = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
  if (alive) console.log("[browser] reusing the browser already running on port " + cdpPort);
  else {
    chrome = spawn(process.env.BROWSER_EXE || findChromium(), [
      `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(process.env.DATA_DIR || dir, "chrome-profile")}`,
      "--no-first-run", "--no-default-browser-check", "--window-size=1200,900", ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []), "about:blank"
    ], { stdio: "ignore" });
    chrome.on("exit", code => console.log("[browser] chrome exited", code));
  }
  const bin = path.join(dir, "node_modules", ".bin", "playwright-mcp");
  // Bound to 127.0.0.1 by address: the server VM cannot resolve the name "localhost", which is the tool's default host.
  const mcp = spawn(bin, ["--port", String(port), "--host", "127.0.0.1", "--cdp-endpoint", `http://127.0.0.1:${cdpPort}`], { stdio: ["ignore", "inherit", "inherit"] });
  mcp.on("exit", code => console.log("[browser] playwright-mcp exited", code));
  return { kill() { mcp.kill(); if (chrome) { chrome.kill(); setTimeout(() => chrome.kill("SIGKILL"), 1500).unref(); } } };
}

export function createBrain({ dir, model = "", timeoutMs = 10 * 60 * 1000 }) {
  // chatId -> claude session id, kept on disk so a restart does not wipe the agent's memory of each chat
  const file = path.join(process.env.DATA_DIR || dir, "sessions.json");
  let sessions = new Map();
  try { sessions = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")))); } catch {}
  const remember = (chatId, id) => { sessions.set(chatId, id); try { writeFileSync(file, JSON.stringify(Object.fromEntries(sessions))); } catch {} };

  function reply(chatId, text, onText) {
    return new Promise(resolve => {
      const args = [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--setting-sources", "project",                        // skip the user's global plugins and hooks
        "--strict-mcp-config", "--mcp-config", path.join(dir, "mcp.json"),
        "--tools", "",                                         // no shell or file tools, only the browser
        "--permission-mode", "bypassPermissions",
        "--system-prompt-file", path.join(dir, "SYSTEM.md")
      ];
      if (model) args.push("--model", model);
      if (sessions.has(chatId)) args.push("--resume", sessions.get(chatId));
      else { const id = randomUUID(); remember(chatId, id); args.push("--session-id", id); }

      const env = agentEnv();
      env.COMEOVER_CHAT = chatId; // tool servers learn which chat they serve
      const p = spawn("claude", args, { env, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      let buf = "", ack = null, usedTool = false, lastText = "", result = null, err = "";

      // Two messages at most reach the chat: what the agent says before its first tool call (an acknowledgement
      // such as "on it"), and its final message. Narration between tool calls goes to the log.
      p.stdout.on("data", d => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.type === "assistant") {
            for (const b of j.message?.content || []) {
              if (b.type === "text" && b.text.trim()) {
                if (!usedTool && ack === null) { ack = b.text.trim(); onText(ack); continue; }
                if (lastText) console.log("[agent] note: " + lastText.replace(/\n/g, " ").slice(0, 120));
                lastText = b.text.trim();
              } else if (b.type === "tool_use") { usedTool = true; console.log("[agent] " + b.name, JSON.stringify(b.input).slice(0, 140)); }
            }
          } else if (j.type === "result") result = j;
        }
      });
      p.stderr.on("data", d => { err += d; });
      p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
      p.stdin.end();
      p.on("close", code => {
        clearTimeout(timer);
        if (lastText) onText(lastText);
        else if (ack === null) {
          const msg = result?.result || result?.error || err.trim().split("\n").pop() || `agent exited with code ${code}`;
          onText("⚠️ " + String(msg).slice(0, 1200));
        }
        if (result) console.log(`[agent] ${result.subtype} · ${result.num_turns} steps · $${(result.total_cost_usd || 0).toFixed(3)}`);
        resolve();
      });
    });
  }

  return { reply };
}
