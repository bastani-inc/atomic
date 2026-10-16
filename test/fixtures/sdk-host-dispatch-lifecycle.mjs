import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@bastani/atomic";
import { getModel } from "@bastani/pi-ai/compat";

// #3105: real built Node exports, independent callback release and natural exit.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "atomic-dispatch-lifecycle-"));
const agentDir = join(cwd, "agent");
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
const settingsManager = SettingsManager.inMemory();
const options = { cwd, agentDir, modelRuntime, settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: [], builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } };
let session;
const release = Promise.withResolvers();
try {
 if (mode.startsWith("path")) {
  const marker = join(cwd, "released");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "broken.ts"), `import { writeFileSync } from "node:fs";
export default function(pi) {
 pi.on("session_shutdown", () => { writeFileSync(${JSON.stringify(marker)}, "released"); ${mode === "path-cleanup" ? 'throw new Error("cleanup rejected");' : ""} });
 throw new Error("factory rejected");
}`);
  const creation = createAgentSession({ ...options, ...(mode === "path-reject" ? { initialContextTransform() { throw new Error("creation rejected"); } } : {}) });
  if (mode === "path-reject") await assert.rejects(creation, /creation rejected/);
  else if (mode === "path-cleanup") await assert.rejects(creation, error => {
   assert.equal(error.code, "ShutdownFailed");
   assert.deepEqual(error.errors.map(cause => cause.message), ["factory rejected", "cleanup rejected"]);
   return true;
  });
  else ({ session } = await creation);
  assert.equal(existsSync(marker), true);
 } else if (mode.startsWith("reload")) {
  const entered = Promise.withResolvers();
  const contexts = [];
  const calls = [];
  const humanInput = { confirm: async (title, message) => { calls.push([title, message]); return true; }, select: async () => undefined, input: async () => "", editor: async () => "", questionnaire: async () => ({ answers: [], cancelled: true }) };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, extensionFactories: [pi => {
   pi.on("session_start", async (event, context) => {
    contexts.push(context);
    if (event.reason === "reload") {
     assert.equal(await context.ui.confirm("new generation", "  raw\n"), true);
     entered.resolve();
     await release.promise;
     if (mode === "reload-reject") throw new Error("startup rejected");
    }
   });
  }] });
  await loader.reload();
  ({ session } = await createAgentSession({ ...options, resourceLoader: loader, extensionBindings: { humanInput } }));
  const captured = contexts[0].ui.confirm;
  const reloading = session.reload();
  const outcome = reloading.catch(error => error);
  await entered.promise;
  await assert.rejects(captured("old generation", "  raw\n"), { code: "SessionClosed" });
  assert.deepEqual(calls, [["new generation", "  raw\n"]]);
  release.resolve();
  const result = await outcome;
  if (mode === "reload-reject") {
   assert.ok(result instanceof Error);
   await assert.rejects(captured("stale captured", ""), { code: "SessionClosed" });
   assert.equal(await session.extensionRunner.createContext().ui.confirm("restored", ""), true);
  } else assert.equal(result, undefined);
 } else {
  const entered = Promise.withResolvers();
  let active = 0;
  let shutdowns = 0;
  let emitBus;
  const suspend = async () => { entered.resolve(); await release.promise; active++; };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, extensionFactories: [pi => {
   if (mode === "thinking") pi.on("thinking_level_select", suspend);
   if (mode === "name") pi.on("session_info_changed", suspend);
   if (mode === "context") pi.on("context", suspend);
   pi.events.on("drain", suspend);
   emitBus = () => pi.events.emit("drain", {});
   pi.registerShortcut("ctrl+shift+j", { handler: suspend });
   pi.on("session_shutdown", () => { shutdowns++; active = 0; });
  }] });
  await loader.reload();
  ({ session } = await createAgentSession({ ...options, resourceLoader: loader, model: getModel("anthropic", "claude-sonnet-4-5") }));
  let mutation;
  if (mode === "thinking") mutation = session.setThinkingLevel("high");
  else if (mode === "name") mutation = session.setSessionName("raw name  ");
  else if (mode === "bus") emitBus();
  else if (mode === "observer") session.extensionRunner.createContext().observeWorkflowActivity(suspend);
  else if (mode === "shortcut") void session.extensionRunner.getShortcuts({}).get("ctrl+shift+j").handler(session.extensionRunner.createContext());
  else void session.extensionRunner.emitContext([]);
  await entered.promise;
  let closed = false;
  const closing = session.dispose().then(() => { closed = true; });
  await tick();
  const closedBeforeRelease = closed;
  const shutdownsBeforeRelease = shutdowns;
  release.resolve();
  await closing;
  await mutation;
  await tick();
  assert.equal(closedBeforeRelease, false);
  assert.equal(shutdownsBeforeRelease, 0);
  assert.equal(active, 0);
  assert.equal(shutdowns, 1);
 }
 console.log(JSON.stringify({ mode, verified: true }));
} finally {
 release.resolve();
 await session?.dispose();
 rmSync(cwd, { recursive: true, force: true });
}
