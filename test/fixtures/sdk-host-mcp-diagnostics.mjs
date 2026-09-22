import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #3105: real builtin logging under non-TTY Node, without intercepting console.
const root = mkdtempSync(join(tmpdir(), "sdk-mcp-diagnostics-"));
process.env.ATOMIC_CODING_AGENT_DIR = join(root, "agent");
process.env.MCP_UI_DEBUG = "1";
const originalConsole = { log: console.log, error: console.error, warn: console.warn, debug: console.debug };
const sessions = [];
const diagnostics = [[], []];
const withoutSink = process.argv.includes("--without-sink");
try {
 const { createAgentSession, SessionManager, SettingsManager, ModelRuntime } = await import("@bastani/atomic");
 const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth"), modelsPath: null, allowModelNetwork: false });
 for (let index = 0; index < 2; index++) {
  const cwd = join(root, String(index));
  mkdirSync(cwd);
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
   [`secret-supervisor-token-${index}`]: { command: join(cwd, "missing-secret-credential") }
  } }));
  // Only the MCP builtin logger is under test. In a source checkout the other
  // four shipped packages load from workspace TypeScript through jiti, which
  // costs ~20 s per session and adds nothing to the owner-sink assertions.
  const { session } = await createAgentSession({ cwd, agentDir: join(root, "agent"), modelRuntime,
   builtins: { workflows: false, subagents: false, "web-access": false, intercom: false },
   settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false } }),
   sessionManager: SessionManager.inMemory(cwd),
   extensionBindings: withoutSink ? undefined : { onDiagnostic: entry => diagnostics[index].push(entry) } });
  sessions.push(session);
 }
 await Promise.all(sessions.map(async (session, index) => {
  const gateway = sessions[index].agent.state.tools.find(tool => tool.name === "mcp");
  const result = await gateway.execute("connect", { connect: `secret-supervisor-token-${index}` }, new AbortController().signal);
  assert.ok(result.details?.error, "unavailable server must report an error");
  if (!withoutSink) {
   assert.ok(diagnostics[index].length > 0, "builtin logger did not report to its owner");
   assert.ok(diagnostics[index].every(entry => entry.sessionId === session.sessionId));
   assert.doesNotMatch(JSON.stringify(diagnostics[index]), /secret|credential|supervisor-token/);
  }
 }));
 await sessions[1].dispose();
 const secondCount = diagnostics[1].length;
 const firstCount = diagnostics[0].length;
 await sessions[0].reload();
 const gateway = sessions[0].agent.state.tools.find(tool => tool.name === "mcp");
 const failed = await gateway.execute("retry", { connect: "secret-supervisor-token-0" }, new AbortController().signal);
 assert.ok(failed.details?.error);
 assert.equal(diagnostics[1].length, secondCount, "reload changed the closed owner's diagnostics");
 if (!withoutSink) assert.ok(diagnostics[0].length > firstCount);
 assert.doesNotMatch(JSON.stringify(diagnostics), /secret|credential|supervisor-token/);
 await sessions[0].dispose();
 for (const [name, method] of Object.entries(originalConsole)) assert.equal(console[name], method);
 console.log(JSON.stringify({ verified: true }));
} finally {
 await Promise.all(sessions.map(session => session.dispose()));
 rmSync(root, { recursive: true, force: true });
}
