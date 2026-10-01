import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentSession, createMcpExtension, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } from "@bastani/atomic";

// #3105: built Node SDK publication and native MCP retirement through public transport hooks.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-publication-cleanup-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
const options = { cwd, agentDir: cwd, settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(cwd), builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } };
let session;
let expectedFailure = false;
try {
 if (mode.startsWith("mcp")) {
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const closeEntered = Promise.withResolvers();
  const state = { active: 0, attempts: 0, cleanupCalls: 0, lateResponses: 0, fail: mode === "mcp-failure" };
  const messages = new Set(); const errors = new Set(); const closes = new Set();
  const subscribe = (listeners, listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  let retirement;
  // A protocol peer whose initialization response and physical retirement are
  // held at the public transport boundary, not a mocked native initializer.
  const transport = {
   async start() { state.active++; },
   async send(message) {
    assert.equal(message.method, "initialize"); entered.resolve();
    await release.promise;
    state.lateResponses++;
    for (const listener of messages) listener({ jsonrpc: "2.0", id: message.id, result: {
     protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } });
   },
   close() {
    if (!retirement) {
     state.attempts++; closeEntered.resolve();
     retirement = release.promise.then(() => { state.active--; for (const listener of closes) listener(); });
    }
    return retirement;
   },
   onMessage: listener => subscribe(messages, listener),
   onError: listener => subscribe(errors, listener),
   onClose: listener => subscribe(closes, listener),
  };
  const mcp = createMcpExtension({
   loadConfig: () => ({ servers: [{ name: "fixture", source: "fixture", config: { command: "fixture", exposure: "direct" } }], errors: [] }),
   createTransport: () => transport,
   logPath: join(cwd, "mcp.log"),
  });
  // Failed SDK cleanup retention is independent of native bounded transport
  // retirement. Inject that failure only after the native resource is retired.
  const cleanup = pi => pi.on("session_shutdown", () => {
   assert.equal(state.active, 0); assert.equal(state.attempts, 1);
   state.cleanupCalls++;
   if (state.fail) throw new Error("companion cleanup failed after native retirement");
  });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [mcp, cleanup] });
  ({ session } = await createAgentSession({ ...options, resourceLoader }));
  await entered.promise;
  let settled = false;
  const closing = session.dispose().then(() => undefined, error => error).finally(() => { settled = true; });
  await closeEntered.promise;
  await delay(20); assert.equal(settled, false); release.resolve();
  const error = await closing; expectedFailure = state.fail;
  assert.equal(state.attempts, 1); assert.equal(state.cleanupCalls, 1);
  assert.equal(state.active, 0); assert.equal(state.lateResponses, 1);
  assert.equal(messages.size + errors.size + closes.size, 0, "retired native client retained transport listeners");
  assert.equal(session.getAllTools().some(tool => tool.name.startsWith("mcp__")), false, "late native initialization published a retired tool");
  if (state.fail) { assert.equal(error?.code, "ShutdownFailed"); await assert.rejects(session.dispose(), again => again === error); }
  else { assert.equal(error, undefined); await session.dispose(); }
  assert.equal(state.attempts, 1); assert.equal(state.cleanupCalls, 1);
 } else {
  const active = new Set(); let next = 0;
  class Loader extends DefaultResourceLoader {
   async prepareReload(...args) {
    const tx = await super.prepareReload(...args);
    return { ...tx, activate(settings) { if (mode.startsWith("activate")) throw new Error("activation failed"); tx.activate(settings); }, prepareCommit() {
     const prepared = tx.prepareCommit(); return { ...prepared, commit() { if (mode === "commit") throw new Error("commit failed"); prepared.commit(); } };
    } };
   }
  }
  const resourceLoader = new Loader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [pi => {
   const id = ++next; pi.on("session_start", () => { active.add(id); }); pi.on("session_shutdown", () => { active.delete(id); if (id === 4 && mode === "activate-cleanup") throw new Error("candidate cleanup failed"); });
  }] });
  await resourceLoader.reload(); ({ session } = await createAgentSession({ ...options, resourceLoader }));
  if (mode === "settings") { const prepare = settingsManager.prepareReload.bind(settingsManager); settingsManager.prepareReload = async () => ({ ...await prepare(), commit() { throw new Error("settings commit failed"); } }); }
  expectedFailure = mode === "activate-cleanup";
  if (mode === "control") await session.reload(); else await assert.rejects(session.reload(), expectedFailure ? { code: "ShutdownFailed" } : /failed/);
  assert.equal(active.size, 1);
  await session.dispose().catch(error => { assert.ok(expectedFailure); assert.equal(error.code, "ShutdownFailed"); }); assert.equal(active.size, 0);
 }
 console.log(JSON.stringify({ mode, verified: true }));
} finally {
 if (session) await session.dispose().catch(error => { if (!expectedFailure) throw error; });
 rmSync(cwd, { recursive: true, force: true });
}
