import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
const { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@bastani/atomic");

// #3105: factories remain concurrent; publication never abandons an admitted owner.
const operation = process.argv[2] ?? "new";
const outcome = process.argv[3] ?? "success";
const root = mkdtempSync(join(tmpdir(), "atomic-concurrent-replacement-"));
const agentDir = join(root, "agent");
const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth"), modelsPath: null, allowModelNetwork: false });
const entered = [Promise.withResolvers(), Promise.withResolvers()];
const release = [Promise.withResolvers(), Promise.withResolvers()];
const active = new Set();
const sessions = new Map();
const rebound = [];
let factories = 0;
async function factory({ cwd, agentDir, sessionManager, sessionStartEvent }) {
 const id = ++factories;
 if (id > 1) {
  entered[id - 2].resolve();
  await release[id - 2].promise;
  if ((outcome === "failure" && id === 2) || outcome === "both-fail") throw new Error(`factory ${id} failed`);
 }
 const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, extensionFactories: [atomic => {
  atomic.on("session_start", () => { active.add(id); if (outcome === "startup" && id === 2) throw new Error("candidate startup failed"); });
  atomic.on("session_shutdown", () => { active.delete(id); if (outcome === "cleanup" && id === 3) throw new Error("displaced cleanup failed"); });
 }] });
 await resourceLoader.reload();
 const result = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader, sessionManager, sessionStartEvent, builtins: { subagents: false, mcp: false, intercom: false, "web-access": false } });
 sessions.set(id, result.session);
 return { ...result, services: { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] }, diagnostics: [] };
}
const manager = await SessionManager.create(root, join(root, "sessions"));
const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir, sessionManager: manager });
const entry = await manager.appendMessage({ role: "user", content: "fork me", timestamp: 0 });
const source = manager.getSessionId();
const imports = operation === "import" ? [await SessionManager.create(root, join(root, "exports")), await SessionManager.create(root, join(root, "exports"))] : [];
let importIndex = 0;
runtime.setRebindSession(async session => { await tick(); assert.equal(runtime.session, session); rebound.push(session); });
const invoke = () => operation === "fork" ? runtime.fork(entry) : operation === "resume" ? runtime.switchSession(source) : operation === "import" ? runtime.importFromJsonl(imports[importIndex++].getSessionFile()) : runtime.newSession();
const a = invoke().catch(error => error);
await entered[0].promise;
const b = invoke().catch(error => error);
let closing;
try {
 await entered[1].promise;
 release[1].resolve();
 const second = await b;
 if (outcome !== "both-fail") assert.equal(second.cancelled, false);
 if (outcome === "dispose") { closing = runtime.dispose(); await tick(); }
 release[0].resolve();
 const first = await a;
 if (outcome === "success") {
  assert.equal(first.cancelled, false);
  assert.deepEqual([...active], [2]);
  assert.equal(runtime.session, sessions.get(2));
  await assert.rejects(sessions.get(3).executeBash("forbidden"), { code: "SessionClosed" });
  assert.deepEqual(rebound, [sessions.get(3), sessions.get(2)]);
 } else if (outcome === "failure" || outcome === "startup") {
  const causes = error => error instanceof AggregateError ? error.errors.flatMap(causes) : [String(error)];
  assert.match(causes(first).join("\n"), outcome === "startup" ? /candidate startup failed/ : /factory 2 failed/);
  assert.deepEqual([...active], [3]);
  assert.equal(runtime.session, sessions.get(3));
 } else if (outcome === "dispose") assert.equal(first.code, "SessionClosed");
 else if (outcome === "cleanup") { assert.equal(first.code, "ShutdownFailed"); assert.equal(active.size, 0, "failed publication must unwind its candidate immediately"); }
 else { assert.match(first.message, /factory 2 failed/); assert.match(second.message, /factory 3 failed/); }
 if (outcome === "cleanup") await assert.rejects(runtime.dispose(), { code: "ShutdownFailed" });
 else await (closing ?? runtime.dispose());
 assert.equal(active.size, 0);
 console.log(JSON.stringify({ operation, outcome, active: active.size, factories }));
} finally {
 release.forEach(gate => gate.resolve());
 await Promise.all([a, b]);
 if (outcome === "cleanup") await assert.rejects(runtime.dispose(), { code: "ShutdownFailed" });
 else await runtime.dispose();
 rmSync(root, { recursive: true, force: true });
}
