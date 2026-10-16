import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentSession, createAgentSessionRuntime, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@bastani/atomic";
import { createAssistantMessageEventStream, getModel } from "@bastani/pi-ai/compat";

// #3105: real Node retirement/settlement proof without forced exit or private cleanup.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-retirement-completion-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
await modelRuntime.setRuntimeApiKey("anthropic", "fixture", {});
const options = { cwd, agentDir: cwd, settingsManager, modelRuntime, model: getModel("anthropic", "claude-sonnet-4-5"), sessionManager: SessionManager.inMemory(cwd), builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } };
const release = Promise.withResolvers();
const entered = Promise.withResolvers();
let session;
let runtime;
let expectedFailure = false;
try {
 if (mode.startsWith("command")) {
  const peerRelease = Promise.withResolvers();
  const peerEntered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  let generations = 0;
  let active = 0;
  const events = [];
  const eventBus = createEventBus();
  const deliveries = [];
  const cleaned = Promise.withResolvers();
  const count = mode === "command-dual" ? 2 : 1;
  const joinReplacement = Promise.withResolvers();
  let enteredCount = 0;
  let returnedCount = 0;
  runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
   const id = ++generations;
   if (id === 2 && mode === "command-create-failure") throw new Error("candidate failed");
   const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, eventBus, noExtensions: true, extensionFactories: [pi => {
    pi.events.on("retired", () => { deliveries.push(id); });
    pi.on("thinking_level_select", async () => { peerEntered.resolve(); await peerRelease.promise; });
    pi.on("session_shutdown", event => { events.push(`shutdown:${id}:${event.reason}`); if (id === 1) { active = 0; pi.events.emit("retired"); cleaned.resolve(); if (mode === "command-cleanup") throw new Error("retiring cleanup failed"); } });
    pi.registerCommand("replace-me", { description: "fixture", handler: async (_args, ctx) => {
     entered.resolve();
     if (++enteredCount === 2) await joinReplacement.promise;
     if (mode === "command-create-failure") await assert.rejects(ctx.newSession(), /candidate failed/);
     else await ctx.newSession();
     if (++returnedCount === count) resumed.resolve();
     await release.promise;
     active++;
    } });
   }] });
   return { ...await createAgentSession({ ...options, sessionManager, sessionStartEvent, resourceLoader }), services: { cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader, diagnostics: [] }, diagnostics: [] };
  }, { cwd, agentDir: cwd, sessionManager: options.sessionManager });
  session = runtime.session;
  await session.bindExtensions({ commandContextActions: { waitForIdle: async () => {}, newSession: o => runtime.newSession(o), fork: (id,o) => runtime.fork(id,o), navigateTree: (id,o) => runtime.session.navigateTree(id,o), switchSession: (file,o) => runtime.switchSession(file,o), reload: () => runtime.session.reload() } });
  await session.setThinkingLevel("high"); await peerEntered.promise;
  const turn = Promise.all(Array.from({ length: count }, () => session.prompt("/replace-me"))); await entered.promise;
  await delay(20); assert.equal(generations, 1); assert.deepEqual(events, []);
  joinReplacement.resolve(); peerRelease.resolve(); await resumed.promise;
  assert.equal(generations, count + 1); assert.equal(events.some(event => event.startsWith("shutdown:1:")), false);
  await assert.rejects(session.prompt("late"), { code: "SessionClosed" });
  if (mode === "command-retired") {
    release.resolve(); await turn; await cleaned.promise; await delay(20);
    assert.deepEqual(deliveries, []);
    assert.equal(active, 0);
  } else {
  let closed = false;
  expectedFailure = mode === "command-cleanup";
  const closing = runtime.dispose().then(() => { closed = true; }, error => { assert.ok(expectedFailure); assert.equal(error.code, "ShutdownFailed"); closed = true; });
  let oldClosed = false;
  const oldClosing = session.dispose().then(() => { oldClosed = true; }, error => { assert.ok(expectedFailure); assert.equal(error.code, "ShutdownFailed"); oldClosed = true; });
  await delay(20); assert.equal(closed, false); assert.equal(oldClosed, false);
  release.resolve(); await Promise.all([turn, closing, oldClosing]);
  assert.equal(active, 0); assert.ok(events.some(event => event.startsWith("shutdown:1:")));
  }
 } else if (mode.startsWith("ordinary")) {
  let fail = false;
  let serial = 0;
  const active = new Set();
  class OrdinaryLoader extends DefaultResourceLoader { supportsTransactionalReload() { return false; } }
  const resourceLoader = new OrdinaryLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [pi => {
   const id = ++serial; active.add(id);
   pi.on("session_shutdown", () => { active.delete(id); if (id === 3 && mode === "ordinary-cleanup") throw new Error("candidate cleanup failed"); });
  }], extensionsOverride: base => { if (fail) throw new Error("discovery failed"); return base; } });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ ...options, resourceLoader }));
  assert.deepEqual([...active], [1,2]); fail = true;
  expectedFailure = mode === "ordinary-cleanup";
  await assert.rejects(session.reload(), expectedFailure ? { code: "ShutdownFailed" } : /discovery failed/);
  assert.deepEqual([...active], [1]);
  await session.dispose().catch(error => { assert.ok(expectedFailure); assert.equal(error.code, "ShutdownFailed"); });
  assert.deepEqual([...active], [1]);
 } else {
  assert.ok(["tool", "tool-control"].includes(mode));
  let count = 0;
  let hooks = 0;
  modelRuntime.streamSimple = model => {
   const stream = createAssistantMessageEventStream(); const tool = ++count === 1;
   queueMicrotask(() => { stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message: { role: "assistant", content: tool ? [{ type: "toolCall", id: "one", name: "fixture_effect", arguments: {} }] : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? "toolUse" : "stop", timestamp: Date.now() } }); stream.end(); }); return stream;
  };
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [pi => { pi.on("tool_result", () => { hooks++; return { content: [{ type: "text", text: "  completed\n" }] }; }); }] });
  ({ session } = await createAgentSession({ ...options, resourceLoader, customTools: [{ name: "fixture_effect", label: "effect", description: "fixture", parameters: { type: "object", properties: {} }, execute: async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "completed" }], details: { completed: true } }; } }] }));
  session.setActiveToolsByName(["fixture_effect"]);
  const turn = session.prompt("run fixture"); await entered.promise;
  if (mode === "tool-control") { release.resolve(); await turn; await session.dispose(); }
  else { const closing = session.dispose(); release.resolve(); await Promise.all([turn, closing]); }
  const result = session.sessionManager.buildSessionContext().messages.find(message => message.role === "toolResult");
  assert.equal(hooks, 1); assert.equal(result.isError, false); assert.deepEqual(result.content, [{ type: "text", text: "  completed\n" }]); assert.deepEqual(result.details, { completed: true });
 }
 console.log(JSON.stringify({ mode, verified: true }));
} finally {
 release.resolve();
 for (const owner of [runtime, session]) await owner?.dispose().catch(error => { if (!expectedFailure) throw error; assert.equal(error.code, "ShutdownFailed"); });
 rmSync(cwd, { recursive: true, force: true });
}
