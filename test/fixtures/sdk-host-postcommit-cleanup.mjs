import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } from "@bastani/atomic";

// #3105: postcommit reconstruction must keep both generations owned through cleanup.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-postcommit-cleanup-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
const active = new Set(); const stopped = []; let next = 0; let committed = false;
const setupError = new Error("postcommit prompt failed");
const invalidationError = new Error("retiring invalidation failed");
class Loader extends DefaultResourceLoader {
 getSystemPrompt() { if (committed && mode !== "control") throw setupError; return super.getSystemPrompt(); }
 async prepareReload(...args) {
  const transaction = await super.prepareReload(...args);
  return { ...transaction, prepareCommit() { const prepared = transaction.prepareCommit(); return { ...prepared, commit() { prepared.commit(); committed = true; } }; } };
 }
}
const loader = new Loader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [atomic => {
 const id = ++next;
 atomic.on("session_start", () => { active.add(id); });
 atomic.on("session_shutdown", () => { active.delete(id); stopped.push(id); if (id === 2 && mode === "shutdown") throw new Error("retiring shutdown failed"); });
}] });
const causes = error => error instanceof AggregateError ? [error, ...error.errors.flatMap(causes)] : error instanceof Error && error.cause ? [error, ...causes(error.cause)] : [error];
let session;
const failedCleanup = mode === "shutdown" || mode === "invalidation";
try {
 await loader.reload();
 ({ session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [], builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } }));
 const retiring = session.extensionRunner; const invalidate = retiring.invalidate.bind(retiring); let invalidated = false;
 retiring.invalidate = (...args) => { invalidated = true; invalidate(...args); if (mode === "invalidation") throw invalidationError; };
 if (mode === "control") await session.reload();
 else await assert.rejects(session.reload(), error => {
  const all = causes(error); assert.ok(all.includes(setupError));
  if (mode === "invalidation") assert.ok(all.includes(invalidationError));
  if (mode === "shutdown") assert.match(all.map(String).join("\n"), /retiring shutdown failed/);
  return true;
 });
 assert.deepEqual([...active], [4]); assert.equal(invalidated, true);
 if (failedCleanup) await assert.rejects(session.dispose(), { code: "ShutdownFailed" }); else await session.dispose();
 assert.equal(active.size, 0); assert.deepEqual(stopped, [3, 2, 4], "include preparation discovery cleanup");
 console.log(JSON.stringify({ mode, verified: true, active: active.size }));
} finally {
 if (session) await session.dispose().catch(error => { if (!failedCleanup) throw error; });
 rmSync(cwd, { recursive: true, force: true });
}
