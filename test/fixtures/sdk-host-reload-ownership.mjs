import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } from "../../packages/coding-agent/dist/index.js";

// #3105: actual built Node ownership transitions; independent release, no forced exit.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-reload-ownership-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
const acquisitions = mode.startsWith("acquire");
const candidate = mode.startsWith("candidate");
const cleanupFails = mode.endsWith("cleanup");
const active = new Set();
const stopped = [];
const capabilities = new Map();
const retiredDeliveries = [];
let next = 0;
let reloading = false;
let invoking;
let release, enter;
const gate = new Promise(resolve => { release = resolve; });
const entered = new Promise(resolve => { enter = resolve; });
class Loader extends DefaultResourceLoader {
  getSystemPrompt() { return super.getSystemPrompt(); }
  supportsTransactionalReload() { return mode !== "self-ordinary"; }
}
let session;
const resourceLoader = new (acquisitions || mode === "self-ordinary" ? Loader : DefaultResourceLoader)({
  cwd, agentDir: cwd, settingsManager, noExtensions: true,
  extensionFactories: [pi => {
    const id = ++next;
    if (acquisitions) active.add(id);
    pi.events.on("acquire", async () => { enter(); await gate; active.add(id); });
    pi.events.on("retired-cleanup", () => { retiredDeliveries.push(id); });
    pi.on("session_start", (_event, ctx) => {
      capabilities.set(id, { write: () => pi.setSessionName(`generation-${id}`), host: () => ctx.getAgentTaskHost() });
      if (candidate && reloading) { pi.events.emit("acquire"); throw new Error("candidate startup failed"); }
    });
    pi.registerCommand("reload-acquire", { description: "reload and finish owned work", handler: async () => {
      invoking = id;
      await session.reload();
      if (mode === "self-twice") await session.reload();
      enter(); await gate; active.add(id);
    } });
    pi.on("session_shutdown", async (_event, ctx) => {
      assert.equal(ctx.cwd, cwd);
      if (id === invoking) {
        await assert.rejects(() => pi.setSessionName("retired-cleanup-write"), /stale|no longer active/i);
        assert.throws(() => ctx.getAgentTaskHost(), /stale|no longer active/i);
        pi.events.emit("retired-cleanup");
      }
      stopped.push(id); active.delete(id);
      if (cleanupFails && id === (acquisitions ? 3 : candidate ? 2 : 1)) throw new Error("owned cleanup failed");
    });
  }],
});
let borrowed = [];
try {
  if (acquisitions || mode === "self-ordinary") { await resourceLoader.reload(); borrowed = [...active]; }
  ({ session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), tools: [], builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } }));
  if (acquisitions) {
    const reload = session.reload(mode === "acquire-failure" ? { beforeSessionStart() { throw new Error("declined reload"); } } : undefined);
    if (mode === "acquire-success") await reload;
    else await assert.rejects(reload, cleanupFails ? { code: "ShutdownFailed" } : /declined reload/);
    assert.equal(active.has(3), false);
  } else {
    reloading = true;
    let settled = false;
    const operation = (candidate ? session.reload() : session.prompt("/reload-acquire")).then(() => { settled = true; }, error => { settled = true; return error; });
    await entered;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false);
    if (candidate) assert.deepEqual(stopped, []);
    else assert.equal(stopped.includes(invoking), false, "invoking generation cannot shut down before its continuation");
    if (!candidate) {
      // External callers are not the admitted continuation whose cleanup is retained.
      await assert.rejects(capabilities.get(invoking).write, /stale|no longer active/i);
      assert.throws(capabilities.get(invoking).host, /stale|no longer active/i);
      const [freshId, fresh] = [...capabilities].at(-1);
      await fresh.write(); assert.ok(fresh.host());
      assert.equal(session.sessionManager.getSessionName(), `generation-${freshId}`);
    }
    let closed = false;
    const close = session.dispose().then(() => { closed = true; }, error => { closed = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, false);
    release();
    const error = await operation;
    if (candidate) assert.ok(error);
    else assert.equal(error, undefined);
    const closeError = await close;
    if (cleanupFails) assert.equal(closeError?.code, "ShutdownFailed");
    else assert.equal(closeError, undefined);
  }
  await session.dispose().catch(error => { assert.equal(cleanupFails, true); assert.equal(error.code, "ShutdownFailed"); });
  assert.deepEqual([...active], borrowed);
  assert.deepEqual(retiredDeliveries, []);
  console.log(JSON.stringify({ mode, verified: true, active: [...active], stopped }));
} finally {
  release();
  await session?.dispose().catch(() => {});
  rmSync(cwd, { recursive: true, force: true });
}
