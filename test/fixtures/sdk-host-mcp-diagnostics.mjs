import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #3105: native MCP reports safe configuration errors to each session's UI,
// without intercepting console or leaking raw configuration credentials.
const root = mkdtempSync(join(tmpdir(), "sdk-mcp-diagnostics-"));
const agentDir = join(root, "agent");
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
const originalConsole = { log: console.log, error: console.error, warn: console.warn, debug: console.debug };
const sessions = [];
const notifications = [[], []];
const withoutSink = process.argv.includes("--without-sink");
try {
 const { createAgentSession, SessionManager, SettingsManager, ModelRuntime } = await import("@bastani/atomic");
 const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth"), modelsPath: null, allowModelNetwork: false });
 for (let index = 0; index < 2; index++) {
  const cwd = join(root, String(index));
  mkdirSync(join(cwd, ".atomic"), { recursive: true });
  // JSON.parse errors can quote the input. Native diagnostics must not forward
  // the malformed file's credentials, even to its owner.
  writeFileSync(join(cwd, ".atomic", "mcp.json"), `secret-supervisor-token-${index}`);
  writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ sessionSummary: { enabled: false } }));
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime,
   builtins: { workflows: false, subagents: false, "web-access": false, intercom: false },
   settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
   sessionManager: SessionManager.inMemory(cwd),
   extensionBindings: withoutSink ? undefined : { uiContext: { notify: (message, type) => notifications[index].push({ message, type }) } } });
  sessions.push(session);
  assert.equal(session.getAllTools().some(tool => tool.name.startsWith("mcp__")), false);
  if (!withoutSink) {
   assert.equal(notifications[index].length, 1, "native MCP must report its configuration error to its owner");
   assert.equal(notifications[index][0].type, "warning");
   assert.match(notifications[index][0].message, /MCP servers need attention/);
   assert.ok(notifications[index][0].message.includes(join(cwd, ".atomic", "mcp.json")));
   assert.doesNotMatch(JSON.stringify(notifications[index]), /secret|credential|supervisor-token/);
  }
 }
 await sessions[1].dispose();
 const secondCount = notifications[1].length;
 const firstCount = notifications[0].length;
 await sessions[0].reload({ failOnExtensionErrors: true });
 assert.equal(notifications[1].length, secondCount, "reload changed the closed owner's notifications");
 if (!withoutSink) {
  assert.equal(notifications[0].length, firstCount + 1);
  assert.ok(notifications[0].every(entry => entry.message.includes(join(root, "0", ".atomic", "mcp.json"))));
  assert.ok(notifications[1].every(entry => entry.message.includes(join(root, "1", ".atomic", "mcp.json"))));
 }
 assert.doesNotMatch(JSON.stringify(notifications), /secret|credential|supervisor-token/);
 await sessions[0].dispose();
 for (const [name, method] of Object.entries(originalConsole)) assert.equal(console[name], method);
 console.log(JSON.stringify({ verified: true }));
} finally {
 await Promise.all(sessions.map(session => session.dispose()));
 rmSync(root, { recursive: true, force: true });
}
