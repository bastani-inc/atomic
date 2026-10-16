import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@bastani/atomic";

// #3105: built public exports must unwind acquisition and report real persistence failures.
const mode = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "atomic-acquisition-persistence-"));
const agentDir = join(root, "agent");
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth"), modelsPath: null, allowModelNetwork: false });
const options = { cwd: root, agentDir, modelRuntime, sessionManager: SessionManager.inMemory(root), builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } };
let session;
let sibling;
try {
 if (mode === "acquisition") {
  let acquired = 0;
  const active = new Set();
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noContextFiles: true, extensionFactories: [pi => {
   const id = ++acquired; active.add(id);
   pi.on("session_shutdown", () => { active.delete(id); });
  }] });
  await loader.reload();
  const cause = new Error("preconstructor failure");
  await assert.rejects(createAgentSession({ ...options, settingsManager, resourceLoader: loader, initialContextTransform() { throw cause; } }), error => error === cause);
  assert.deepEqual([...active], [1]);
 } else if (mode === "shell") {
  ({ session } = await createAgentSession({ ...options, settingsManager: SettingsManager.inMemory() }));
  const signals = [];
  const finishes = [];
  const operations = { exec: async (_command, _cwd, { signal }) => new Promise(resolve => { signals.push(signal); finishes.push(() => resolve({ exitCode: 0 })); signal.addEventListener("abort", () => resolve({ exitCode: 0 }), { once: true }); }) };
  const a = session.executeBash("first", undefined, { id: "raw id  ", operations });
  const b = session.executeBash("second", undefined, { id: "raw id  ", operations });
  try {
   await tick(); const close = session.dispose(); await tick();
   assert.deepEqual(signals.map(signal => signal.aborted), [true, true]);
   await Promise.all([a, b, close]);
  } finally { finishes.forEach(finish => finish()); await Promise.all([a, b]); }
 } else {
  ({ session } = await createAgentSession(options));
  ({ session: sibling } = await createAgentSession({ ...options, settingsManager: session.settingsManager }));
  const file = join(agentDir, "settings.json");
  await session.settingsManager.flush(); rmSync(file, { force: true }); mkdirSync(file, { recursive: true });
  await session.setThinkingLevel("off", { persist: true });
  await sibling.dispose();
  await assert.rejects(session.dispose(), { code: "ShutdownFailed" });
  assert.ok(session.settingsManager.drainErrors().some(({ error }) => /EISDIR/.test(error.message)));
 }
 console.log(JSON.stringify({ mode, verified: true }));
} finally {
 await Promise.allSettled([session?.dispose(), sibling?.dispose()]);
 rmSync(root, { recursive: true, force: true });
}
