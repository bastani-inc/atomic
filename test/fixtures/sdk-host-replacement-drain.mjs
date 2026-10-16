import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@bastani/atomic";

// #3105: replacement admission spans preflight, factory and startup; close drains it.
const phase = process.argv[2] ?? "factory";
const operation = process.argv[3] ?? "new";
const failure = process.argv[4] ?? "none";
const root = mkdtempSync(join(tmpdir(), "atomic-replacement-drain-"));
const agentDir = join(root, "agent");
const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
const entered = Promise.withResolvers();
const release = Promise.withResolvers();
const active = new Set();
let factories = 0;
async function pause() { entered.resolve(); await release.promise; }
async function factory({ cwd, agentDir, sessionManager, sessionStartEvent }) {
 const id = ++factories;
 if (id === 2 && phase === "factory") await pause();
 const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, extensionFactories: [pi => {
  pi.on("session_before_switch", async () => { if (phase === "preflight") await pause(); });
  pi.on("session_before_fork", async () => { if (phase === "preflight") await pause(); });
  pi.on("session_start", async () => { active.add(id); if (id === 2 && phase === "startup") { await pause(); if (failure === "rollback") throw new Error("startup failed"); } });
  pi.on("session_shutdown", () => { active.delete(id); if (id === 2 && failure !== "none") throw new Error("candidate cleanup failed"); });
 }] });
 await resourceLoader.reload();
 const result = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader, sessionManager, sessionStartEvent, builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } });
 return { ...result, services: { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] }, diagnostics: [] };
}
if (phase === "prepare") factory.prepareResume = async (options) => { await pause(); return () => factory(options); };
const manager = await SessionManager.create(root, join(root, "sessions"));
const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir, sessionManager: manager });
const old = runtime.session;
const entry = await manager.appendMessage({ role: "user", content: "fork me", timestamp: 0 });
const invoke = () => operation === "fork" ? runtime.fork(entry) : operation === "resume" ? runtime.switchSession(manager.getSessionFile()) : operation === "import" ? runtime.importFromJsonl(manager.getSessionFile()) : runtime.newSession();
const result = invoke().catch(error => error);
try {
 await entered.promise;
 let closed = false;
 const closing = runtime.dispose();
 assert.equal(runtime.dispose(), closing);
 const closeOutcome = closing.then(() => { closed = true; }, error => { closed = true; return error; });
 await tick();
 assert.equal(closed, false, "close must drain admitted replacement");
 release.resolve();
 const outcome = await result;
 if (failure === "rollback") assert.ok(outcome instanceof AggregateError);
 else assert.equal(outcome.code, "SessionClosed");
 const closeError = await closeOutcome;
 if (failure === "none") assert.equal(closeError, undefined);
 else { assert.equal(closeError.code, "ShutdownFailed"); assert.match(String(closeError.errors), /Session shutdown failed/); }
 assert.equal(runtime.session, old, "do not publish candidate after terminal seal");
 assert.equal(active.size, 0);
 await assert.rejects(invoke(), { code: "SessionClosed" });
 await assert.rejects(runtime.session.executeBash("echo forbidden"), { code: "SessionClosed" });
 console.log(JSON.stringify({ phase, operation, failure, drained: true, active: active.size }));
} finally {
 release.resolve(); await result;
 if (failure === "none") await runtime.dispose();
 else await assert.rejects(runtime.dispose(), { code: "ShutdownFailed" });
 rmSync(root, { recursive: true, force: true });
}
