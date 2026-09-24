import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
const workflow = process.argv[4] === "workflow";
if (workflow) {
 const home = process.env.ATOMIC_MANAGED_TEST_HOME;
 assert.ok(home && resolve(homedir()) === resolve(home) && process.env.USERPROFILE === home, "retained workflow fixture requires a disposable managed HOME");
 assert.ok(home.startsWith(tmpdir()) && home.includes("atomic-real-postgres-"), "requires RealPostgresHome");
 assert.equal(process.env.DBOS_SYSTEM_DATABASE_URL, undefined);
 assert.equal(process.env.PGPORT, "0", "Docker fallback must be disabled");
 const metadata = JSON.parse(readFileSync(join(home, ".atomic", "postgres", "v18.shared", "cluster.json"), "utf8"));
 assert.equal(String(metadata.server.port), process.env.ATOMIC_POSTGRES_PORT);
}
const { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@bastani/atomic");

// #3105: factories remain concurrent; publication never abandons an admitted owner.
const operation = process.argv[2] ?? "new";
const outcome = process.argv[3] ?? "success";
const root = mkdtempSync(join(tmpdir(), "atomic-concurrent-replacement-"));
if (workflow) {
 process.env.ATOMIC_FAULT_TEST_HOME = root;
 const directory = join(root, ".atomic", "workflows");
 mkdirSync(directory, { recursive: true });
 writeFileSync(join(directory, "sdk-host-durable.ts"), readFileSync(new URL("./sdk-host-durable-workflow.ts", import.meta.url)));
}
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
 const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, extensionFactories: [pi => {
  pi.on("session_start", () => { active.add(id); if (outcome === "startup" && id === 2) throw new Error("candidate startup failed"); });
  pi.on("session_shutdown", () => { active.delete(id); if (outcome === "cleanup" && id === 3) throw new Error("displaced cleanup failed"); });
 }] });
 await resourceLoader.reload();
 const result = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader, sessionManager, sessionStartEvent, builtins: { workflows: workflow, subagents: false, mcp: false, intercom: false, "web-access": false } });
 sessions.set(id, result.session);
 return { ...result, services: { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] }, diagnostics: [] };
}
const manager = SessionManager.create(root, join(root, "sessions"));
const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir, sessionManager: manager });
const entry = manager.appendMessage({ role: "user", content: "fork me", timestamp: 0 });
await manager.flush();
const source = manager.getSessionFile();
runtime.setRebindSession(async session => { await tick(); assert.equal(runtime.session, session); rebound.push(session); });
const invoke = () => operation === "fork" ? runtime.fork(entry) : operation === "resume" ? runtime.switchSession(source) : operation === "import" ? runtime.importFromJsonl(source) : runtime.newSession();
if (workflow) {
 await runtime.session.prompt("/workflow sdk-host-durable --no-picker");
 const tool = runtime.session.agent.state.tools.find(tool => tool.name === "workflow");
 let status;
 const deadline = Date.now() + 10_000;
 do {
  status = (await tool.execute("pending", { action: "status" }, new AbortController().signal)).details;
  if (status.runs[0]?.awaitingInputCount === 1) break;
  await new Promise(resolve => setTimeout(resolve, 20));
 } while (Date.now() < deadline);
 assert.equal(status.runs[0]?.awaitingInputCount, 1);
}
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
 if (workflow && (outcome === "success" || outcome === "failure" || outcome === "startup")) {
  const tool = runtime.session.agent.state.tools.find(tool => tool.name === "workflow");
  const status = (await tool.execute("retained", { action: "status" }, new AbortController().signal)).details;
  // #3203: switching sessions quits the run at a resumable checkpoint instead of leaving it detached.
  assert.equal(status.runs[0]?.status, "paused", JSON.stringify(status));
  assert.equal(status.runs[0]?.exitReason, "quit", JSON.stringify(status));
  assert.equal(status.snapshots[0]?.resumable, true, JSON.stringify(status));
  assert.equal(status.runs[0]?.awaitingInputCount, 1, JSON.stringify(status));
 }
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
