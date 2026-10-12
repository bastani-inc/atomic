import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@bastani/atomic";
import { createAssistantMessageEventStream, getModel } from "@bastani/pi-ai/compat";

// #3105: built Node public lifecycle proof, independent release, no forced exit.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-completion-cleanup-"));
const release = Promise.withResolvers();
const entered = Promise.withResolvers();
const completed = Promise.withResolvers();
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
await modelRuntime.setRuntimeApiKey("anthropic", "fixture", {});
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: mode.startsWith("summary") }, retry: { enabled: false }, compaction: { enabled: false } });
const options = { cwd, agentDir: cwd, modelRuntime, model: getModel("anthropic", "claude-sonnet-4-5"), settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: [], builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } };
const active = new Set();
const signals = [];
let serial = 0;
let session;
let expectedCleanupFailure = false;
modelRuntime.streamSimple = (model, context, streamOptions) => {
 const stream = createAssistantMessageEventStream();
 const finish = () => {
  stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "completed before close" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
  stream.end(); completed.resolve();
 };
 if (JSON.stringify(context.messages).includes("Describe this coding session in one short sentence")) {
  const id = ++serial; active.add(id); signals.push(streamOptions.signal); entered.resolve();
  void release.promise.then(() => { active.delete(id); finish(); });
 } else queueMicrotask(finish);
 return stream;
};
try {
 if (mode.startsWith("prepare")) {
  let fail = false;
  const shutdowns = [];
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [
   pi => { const id = ++serial; active.add(id); pi.on("session_shutdown", () => { active.delete(id); shutdowns.push(id); if (id === 2 && mode === "prepare-cleanup") throw new Error("earlier cleanup failed"); }); },
   pi => { if (fail && mode === "prepare-cleanup") { pi.on("session_shutdown", () => { throw new Error("later cleanup failed"); }); throw new Error("later factory failed"); } },
  ], extensionsOverride: base => { if (fail && mode === "prepare") throw new Error("override failed"); return base; } });
  ({ session } = await createAgentSession({ ...options, resourceLoader: loader }));
  fail = true;
  const error = await session.reload().then(() => undefined, cause => cause);
  assert.ok(error instanceof Error);
  assert.deepEqual([...active], [1]);
  if (mode === "prepare-cleanup") {
   expectedCleanupFailure = true;
   assert.equal(error.code, "ShutdownFailed");
   const messages = cause => cause instanceof AggregateError ? [...cause.errors].map(messages).join(";") : String(cause);
   for (const text of ["earlier cleanup failed", "later cleanup failed", "later factory failed"]) assert.ok(messages(error).includes(text));
  }
  await session.dispose().catch(error => { assert.ok(expectedCleanupFailure); assert.equal(error.code, "ShutdownFailed"); });
  assert.deepEqual(shutdowns, [2, 1]);
 } else if (mode === "persist") {
  const events = [];
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [pi => {
   // Provider requests wait for queued session events, so the gate holds the run open after the conversation events completed.
   pi.on("agent_end", async () => { entered.resolve(); await release.promise; });
   pi.on("message_end", event => { events.push(event.message.role); });
  }] });
  ({ session } = await createAgentSession({ ...options, resourceLoader: loader }));
  const turn = session.prompt("preserve  raw\n"); await entered.promise; await completed.promise; await tick();
  const closing = session.dispose(); release.resolve(); await Promise.all([turn, closing]);
  const messages = session.sessionManager.buildSessionContext().messages;
  const conversational = messages.filter((message) => message.role !== "system");
  assert.deepEqual(conversational.map((message) => message.role), ["user", "assistant"]);
  assert.equal(conversational[0].content[0].text, "preserve  raw\n");
  assert.deepEqual(events.filter((role) => role !== "system"), ["user", "assistant"]);
 } else {
  assert.ok(["summary", "summary-superseded", "summary-reload"].includes(mode));
  ({ session } = await createAgentSession({ ...options, extensionBindings: { mode: "rpc" } }));
  await session.prompt("first"); await entered.promise;
  if (mode === "summary-superseded") {
   await session.prompt("second");
   const deadline = Date.now() + 5000;
   while (active.size !== 2 && Date.now() < deadline) await tick();
   assert.equal(active.size, 2);
  }
  let closed = false;
  const closing = (mode === "summary-reload" ? session.reload() : session.dispose()).then(() => { closed = true; });
  const deadline = Date.now() + 5000;
  while (!closed && Date.now() < deadline) await tick();
  assert.equal(closed, true, "lifecycle operation completes before provider release");
  assert.equal(active.size, mode === "summary-superseded" ? 2 : 1);
  assert.equal(signals.length, active.size);
  assert.ok(signals.every(signal => signal.aborted));
  release.resolve(); await closing; await tick();
  assert.equal(session.sessionManager.getEntries().some(entry => entry.type === "session_summary"), false);
 }
 assert.equal(active.size, 0);
 console.log(JSON.stringify({ mode, verified: true, active: active.size }));
} finally {
 release.resolve();
 await session?.dispose().catch(error => { if (!expectedCleanupFailure) throw error; assert.equal(error.code, "ShutdownFailed"); });
 rmSync(cwd, { recursive: true, force: true });
}
