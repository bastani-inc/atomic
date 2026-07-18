import { mkdirSync } from "node:fs";
import { SessionManager } from "@bastani/atomic";

const [sessionDir, cwd, id, pairsRaw = "20", linesRaw = "60"] = process.argv.slice(2);
if (!sessionDir || !cwd || !id) throw new Error("usage: seed-history.ts SESSION_DIR CWD ID [PAIRS] [LINES]");
mkdirSync(sessionDir, { recursive: true });
const manager = SessionManager.create(cwd, sessionDir, { id });
let state = 0x1844b00b >>> 0;
const text = (role: string, turn: number, lines: number): string => {
  const rows: string[] = [];
  for (let line = 1; line <= lines; line++) {
    let body = "";
    while (body.length < 48) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      body += (state >>> 0).toString(16).padStart(8, "0");
    }
    rows.push(`${role}-${String(turn).padStart(3, "0")}-${String(line).padStart(3, "0")}:${body}`);
  }
  return rows.join("\n");
};
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const pairs = Number(pairsRaw); const lines = Number(linesRaw); let timestamp = 1_750_000_000_000;
for (let turn = 1; turn <= pairs; turn++) {
  manager.appendMessage({ role: "user", content: [{ type: "text", text: text("user", turn, lines) }], timestamp: timestamp++ });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: text("assistant", turn, lines) }],
    api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: zeroUsage,
    stopReason: "stop", timestamp: timestamp++ });
}
console.log(manager.getSessionFile());
