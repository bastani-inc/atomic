import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, AgentSessionRuntime, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } from "@bastani/atomic";

// #3105: failed outgoing retirement must still finalize resources held until terminal shutdown.
const operation = process.argv[2] ?? "new";
const failQuit = process.argv[3] === "cleanup";
const cwd = mkdtempSync(join(tmpdir(), "atomic-retirement-failure-"));
const agentDir = join(cwd, "agent");
const settingsManager = SettingsManager.inMemory();
const sessionManager = await SessionManager.create(cwd, join(cwd, "sessions"));
const entry = await sessionManager.appendMessage({ role: "user", content: "fork me", timestamp: 0 });
const importSource = operation === "import" ? await SessionManager.create(cwd, join(cwd, "exports")) : undefined;
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false });
const shutdowns = [];
let keepAlive;
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true,
 extensionFactories: [atomic => {
  atomic.on("session_start", () => { keepAlive = setInterval(() => {}, 60_000); });
  atomic.on("session_shutdown", event => {
   shutdowns.push(event.reason);
   if (event.reason !== "quit") throw new Error("retirement failed");
   clearInterval(keepAlive);
   keepAlive = undefined;
   if (failQuit) throw new Error("final cleanup failed");
  });
 }],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, sessionManager, modelRuntime, resourceLoader, builtins: { subagents: false, mcp: false, intercom: false, "web-access": false } });
let creations = 0;
const runtime = new AgentSessionRuntime(session, { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] }, async () => { creations++; throw new Error("must not create successor"); });
assert.ok(keepAlive?.hasRef(), "the extension owns an active resource before retirement");
const invoke = () => operation === "fork" ? runtime.fork(entry) : operation === "resume" ? runtime.switchSession(sessionManager.getSessionId()) : operation === "import" ? runtime.importFromJsonl(importSource.getSessionFile()) : runtime.newSession();
const replacementError = await invoke().catch(error => error);
assert.equal(replacementError?.code, "ShutdownFailed");
const closing = runtime.dispose();
assert.equal(runtime.dispose(), closing);
const closeError = await closing.catch(error => error);
assert.equal(closeError?.code, "ShutdownFailed");
const causes = error => error instanceof AggregateError ? `${error.message} ${error.errors.map(causes).join(" ")}` : `${String(error)} ${error?.cause ? causes(error.cause) : ""}`;
assert.match(causes(replacementError), /retirement failed/);
if (failQuit) assert.match(causes(replacementError), /final cleanup failed/);
assert.equal(keepAlive, undefined, "terminal cleanup released the extension's resource");
assert.equal(creations, 0);
assert.equal(runtime.session, session);
assert.deepEqual(shutdowns, [operation === "fork" ? "fork" : operation === "new" ? "new" : "resume", "quit"]);
await assert.rejects(session.prompt("retired"), { code: "SessionClosed" });
console.log(JSON.stringify({ operation, failQuit, finalized: true, creations }));
rmSync(cwd, { recursive: true, force: true });
// Natural process exit is part of the oracle.
