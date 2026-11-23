import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as poll } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// RFC #2884: bounded actual terminal input; never capture ahead of a renderer barrier.
const FIXTURE_BARRIER_TIMEOUT_MS = 30000;
const FIXTURE_EXIT_TIMEOUT_MS = 10000;
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
 chat: { type: "string", default: "main" }, session: { type: "string", default: "atomic-task" },
 "evidence-root": { type: "string" }, dir: { type: "string" }, "run-id": { type: "string" },
 barrier: { type: "string" }, "command-id": { type: "string" }, "after-revision": { type: "string", default: "-1" },
 "timeout-ms": { type: "string", default: String(FIXTURE_BARRIER_TIMEOUT_MS) }, columns: { type: "string", default: "100" }, rows: { type: "string", default: "30" },
 "fail-after-shell": { type: "boolean", default: false },
} });
function records(path) { if (!existsSync(path)) return []; const text = readFileSync(path, "utf8"); return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(JSON.parse); }
async function wait(directory, nonce, barrier, commandId, after = -1, live = () => { const path = join(directory, "fixture-process.json"); return existsSync(path) && identityAlive(JSON.parse(readFileSync(path, "utf8"))); }) {
 const deadline = Date.now() + Number(values["timeout-ms"]);
 while (Date.now() < deadline) {
  for (const item of records(join(directory, "barriers.jsonl"))) {
   assert.equal(item.runId, nonce, "Wrong fixture run");
   if (item.barrier === barrier && item.commandId === commandId && Number(item.revision) > after) return item;
  }
  assert.ok(live(), `Fixture exited before ${barrier}(${commandId})`);
  if (existsSync(join(directory, "failure.log"))) throw new Error(readFileSync(join(directory, "failure.log"), "utf8"));
  await poll(20);
 }
 throw new Error(`Deadline waiting for ${barrier}(${commandId})`);
}
function identityAlive(identity) {
	try {
		process.kill(identity.pid, 0);
		if (identity.birth === undefined) return true;
		if (process.platform !== "linux") return true;
		const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === identity.birth;
	} catch {
		return false;
	}
}
if (positionals[0] === "wait") {
 assert.ok(values.dir && values["run-id"] && values.barrier && values["command-id"]);
 console.log(JSON.stringify(await wait(values.dir, values["run-id"], values.barrier, values["command-id"], Number(values["after-revision"]))));
} else {
 assert.equal(positionals[0], "run"); assert.ok(values["evidence-root"]);
 assert.ok(values.chat === "main");
 const nonce = randomUUID(); const directory = resolve(values["evidence-root"], nonce);
 mkdirSync(dirname(directory), { recursive: true });
 assert.ok(!existsSync(directory), "Refuse evidence reuse");
 const session = `${values.session}-${nonce}`;
 const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
 const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8", timeout: FIXTURE_EXIT_TIMEOUT_MS });
 const live = () => spawnSync("tmux", ["has-session", "-t", session], { timeout: FIXTURE_EXIT_TIMEOUT_MS }).status === 0;
 const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
 const send = (action, id) => { tmux("send-keys", "-t", session, "-l", "--", `/fixture ${action} --command-id ${id}`); tmux("send-keys", "-t", session, "Enter"); };
 let revision = -1;
 const rendered = async (id, predicate = () => {}) => { const item = await wait(directory, nonce, "rendered", id, revision, live); predicate(item.evidence); revision = Number(item.revision); return item; };
 const capture = (name, pattern) => { const text = tmux("capture-pane", "-t", session, "-p"); writeFileSync(join(directory, name), text); if (pattern) assert.match(text, pattern); return text; };
 const awaitExit = async () => { const deadline = Date.now() + FIXTURE_EXIT_TIMEOUT_MS; while (live() && Date.now() < deadline) await poll(20); assert.ok(!live(), "Fixture did not exit"); };
 const inspect = async (name) => { tmux("send-keys", "-t", session, "-l", "--", "/tasks"); tmux("send-keys", "-t", session, "Enter"); await rendered("inspect"); capture(name, /t17 Inspect deterministic fixture/); tmux("send-keys", "-t", session, "Escape"); await rendered("inspection-closed"); };
 try {
  tmux("-V");
  const home = join(dirname(directory), `${nonce}-home`); mkdirSync(home);
  // A tmux server can retain another Atomic invocation's engine/session/test markers.
  const tzArg = process.env.TZ ? ` TZ=${quote(process.env.TZ)}` : "";
  tmux("new-session", "-d", "-s", session, "-c", cwd, "-x", values.columns, "-y", values.rows, `exec env -i PATH=${quote(process.env.PATH)} HOME=${quote(home)} TERM=xterm-256color${tzArg} bun ${quote(join(cwd, "test/fixtures/task-experience-session.ts"))} --chat ${values.chat} --evidence-dir ${quote(directory)} --run-id ${nonce} 2>${quote(join(dirname(directory), `${nonce}-stderr.log`))}`);
  const ready = await wait(directory, nonce, "ready", "boot", -1, live); assert.equal(ready.evidence.host, values.chat); assert.ok(ready.evidence.ownerId);
  await rendered("boot");
  send("intercom", "live"); const started = await wait(directory, nonce, "intercom-live", "live", -1, live);
  assert.equal(started.evidence.startCount, 1); assert.equal(started.evidence.genuineMessageCount, 1); assert.equal(started.evidence.execution, "running"); assert.equal(started.evidence.observation.reason, "default-background"); assert.ok(BigInt(started.evidence.activityCursor.sequence) > BigInt(started.evidence.yieldCursor.sequence));
  const liveRender = await rendered("live", (e) => { assert.equal(e.anchorCount, 0); assert.ok(e.taskIds.includes(started.taskId)); }); assert.equal(liveRender.cursor.generation, started.cursor.generation); assert.ok(BigInt(liveRender.cursor.sequence) >= BigInt(started.cursor.sequence)); capture("live.txt", /◯ worker {2}.*Inspect deterministic fixture/);
  await inspect("live-inspector.txt");
  tmux("send-keys", "-t", session, "C-o"); await rendered("expand", (e) => assert.equal(e.toolsExpanded, true)); capture("expanded.txt");
  send("complete t17", "done"); const terminal = await wait(directory, nonce, "terminal", "done", -1, live); assert.equal(terminal.taskId, started.taskId);
  const persisted = await wait(directory, nonce, "model-persisted", "done", -1, live); assert.equal(persisted.evidence.count, 1); assert.equal(persisted.evidence.display, true); assert.equal(persisted.evidence.completionId, terminal.evidence.completionId);
  const settledRender = await rendered("done", (e) => assert.equal(e.completionCount, 1)); assert.equal(settledRender.cursor.generation, terminal.cursor.generation); assert.ok(BigInt(settledRender.cursor.sequence) >= BigInt(terminal.cursor.sequence)); const settled = capture("settled.txt", /● \S+ finished/); assert.match(settled, /Fixture complete/); assert.doesNotMatch(settled, /Tasks.*local agent/); assert.doesNotMatch(settled, /◯ worker {2}/);
  await inspect("settled-inspector.txt");
  tmux("resize-window", "-t", session, "-x", "48", "-y", "16"); await rendered("resize", (e) => { assert.equal(e.columns, 48); assert.equal(e.rows, 16); });
  send("shell", "shell"); const shell = await wait(directory, nonce, "shell-ready", "shell", -1, live); assert.ok(identityAlive(shell.evidence.identities.parent) && identityAlive(shell.evidence.identities.grandchild));
  await rendered("shell"); capture("shell.txt");
  if (values["fail-after-shell"]) assert.fail("Fixture assertion after shell admission");
  send("close-owner", "close"); const cleanup = await wait(directory, nonce, "cleanup", "close", -1, live); assert.ok(cleanup.evidence.receipt.tasks.every((item) => item.cleanup.kind === "reaped")); assert.ok(!identityAlive(shell.evidence.identities.parent) && !identityAlive(shell.evidence.identities.grandchild));
  await rendered("close"); capture("closed.txt");
  send("quit", "quit"); await wait(directory, nonce, "stopped", "quit", -1, () => true); await awaitExit();
  console.log(`PASS ${values.chat} ${directory}`);
 } catch (error) {
  if (existsSync(directory)) { writeFileSync(join(directory, "driver-failure.log"), `${error.stack}\n`); if (live()) capture("failure.txt"); }
  throw error;
 } finally {
  if (live()) { tmux("send-keys", "-t", session, "C-c"); try { await awaitExit(); } finally { if (live()) tmux("kill-session", "-t", session); } }
  const path = join(directory, "identities.json"); if (existsSync(path)) { const identities = JSON.parse(readFileSync(path, "utf8")); assert.ok(!identityAlive(identities.parent) && !identityAlive(identities.grandchild), "Native process identity survived cleanup"); }
 }
}
