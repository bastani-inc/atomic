import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@bastani/atomic";

// #3105: a peer's late preflight cannot retire a successor while its host is binding.
const nested = process.argv[2] === "nested";
const root = mkdtempSync(join(tmpdir(), "atomic-binding-overlap-"));
const agentDir = join(root, "agent");
const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth"), modelsPath: null, allowModelNetwork: false });
const preflight = Promise.withResolvers();
const releasePreflight = Promise.withResolvers();
const binding = Promise.withResolvers();
const releaseBinding = Promise.withResolvers();
let switches = 0;
let bound = 0;
const active = new Set();
let factories = 0;
async function factory({ cwd, agentDir, sessionManager, sessionStartEvent }) {
 const id = ++factories;
 const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, extensionFactories: [atomic => {
  atomic.on("session_before_switch", async () => { if (!nested && ++switches === 1) { preflight.resolve(); await releasePreflight.promise; } });
  atomic.on("session_start", () => { active.add(id); });
  atomic.on("session_shutdown", () => { active.delete(id); });
 }] });
 await resourceLoader.reload();
 const result = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader, sessionManager, sessionStartEvent, builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } });
 return { ...result, services: { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] }, diagnostics: [] };
}
const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir, sessionManager: SessionManager.inMemory(root) });
runtime.setRebindSession(async session => {
 if (++bound === 1) {
  if (nested) { await runtime.newSession(); return; }
  binding.resolve(session); await releaseBinding.promise;
  assert.equal(runtime.session, session);
  await session.bindExtensions({});
 }
});
const a = runtime.newSession().catch(error => error);
if (!nested) await preflight.promise;
const b = nested ? Promise.resolve({ cancelled: false }) : runtime.newSession().catch(error => error);
try {
 if (!nested) {
	await tick(); await tick();
	assert.deepEqual([...active], [1], "retirement waits for admitted preflight before shutdown");
	assert.equal(bound, 0, "successor cannot bind before independent preflight release");
	releasePreflight.resolve();
	const bindingSession = await binding.promise;
 await tick(); await tick();
 await bindingSession.bindExtensions({});
 releaseBinding.resolve();
 }
 assert.equal((await a).cancelled, false);
 assert.equal((await b).cancelled, false);
 await runtime.dispose();
 assert.equal(active.size, 0);
 console.log(JSON.stringify({ active: active.size, bound }));
} finally {
 releasePreflight.resolve(); releaseBinding.resolve();
 await Promise.all([a, b]);
 await runtime.dispose();
 rmSync(root, { recursive: true, force: true });
}
