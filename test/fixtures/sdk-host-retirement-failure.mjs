import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createAgentSession, AgentSessionRuntime, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } from "@bastani/atomic";

// #3105: failed outgoing retirement must still finalize retained durable ownership.
const operation = process.argv[2] ?? "new";
const failQuit = process.argv[3] === "cleanup";
const cwd = mkdtempSync(join(tmpdir(), "atomic-retirement-failure-"));
const agentDir = join(cwd, "agent");
process.env.ATOMIC_FAULT_TEST_HOME = cwd;
mkdirSync(join(cwd, ".atomic", "workflows"), { recursive: true });
writeFileSync(join(cwd, ".atomic", "workflows", "sdk-host-durable.ts"), readFileSync(new URL("./sdk-host-durable-workflow.ts", import.meta.url)));
const settingsManager = SettingsManager.inMemory();
const sessionManager = await SessionManager.create(cwd, join(cwd, "sessions"));
const entry = await sessionManager.appendMessage({ role: "user", content: "fork me", timestamp: 0 });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false });
const shutdowns = [];
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true,
 extensionFactories: [pi => pi.on("session_shutdown", event => {
  shutdowns.push(event.reason);
  if (event.reason !== "quit") throw new Error("retirement failed");
  if (failQuit) throw new Error("final cleanup failed");
 })],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, sessionManager, modelRuntime, resourceLoader, builtins: { subagents: false, mcp: false, intercom: false, "web-access": false } });
let creations = 0;
const runtime = new AgentSessionRuntime(session, { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] }, async () => { creations++; throw new Error("must not create successor"); });
await session.prompt("/workflow sdk-host-durable --no-picker");
const tool = session.agent.state.tools.find(t => t.name === "workflow");
let before;
for (let i = 0; i < 250; i++) {
 before = (await tool.execute("status", { action: "status" }, new AbortController().signal)).details;
 if (before.runs[0]?.awaitingInputCount === 1) break;
 await sleep(20);
}
assert.equal(before.runs[0]?.status, "running");
assert.equal(before.runs[0]?.awaitingInputCount, 1);
const invoke = () => operation === "fork" ? runtime.fork(entry) : operation === "resume" ? runtime.switchSession(sessionManager.getSessionFile()) : operation === "import" ? runtime.importFromJsonl(sessionManager.getSessionFile()) : runtime.newSession();
const replacementError = await invoke().catch(error => error);
assert.equal(replacementError?.code, "ShutdownFailed");
const closing = runtime.dispose();
assert.equal(runtime.dispose(), closing);
const closeError = await closing.catch(error => error);
assert.equal(closeError?.code, "ShutdownFailed");
const causes = error => error instanceof AggregateError ? `${error.message} ${error.errors.map(causes).join(" ")}` : `${String(error)} ${error?.cause ? causes(error.cause) : ""}`;
assert.match(causes(replacementError), /retirement failed/);
if (failQuit) assert.match(causes(replacementError), /final cleanup failed/);
assert.equal(creations, 0);
assert.equal(runtime.session, session);
assert.deepEqual(shutdowns, [operation === "fork" ? "fork" : operation === "new" ? "new" : "resume", "quit"]);
await assert.rejects(session.prompt("retired"), { code: "SessionClosed" });
console.log(JSON.stringify({ operation, failQuit, finalized: true, creations }));
rmSync(cwd, { recursive: true, force: true });
// Natural process exit is part of the oracle.
