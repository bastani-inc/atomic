// #3020 regression: real nested invocation, SDK lifecycle and broker; deterministic model, no credentials.
// After npm run build: node test/fixtures/nested-fallback-cli-driver.mjs /tmp/fresh-evidence [primary|fallback] [cold|cold-top]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(process.argv[2]);
const cold = process.argv[4] === "cold" || process.argv[4] === "cold-top";
const probeTop = process.argv[4] === "cold-top";
assert.ok(!existsSync(evidence), "use a fresh evidence directory");
const project = join(evidence, "project");
const agent = join(evidence, "agent");
mkdirSync(join(project, ".atomic/workflows"), { recursive: true });
mkdirSync(join(project, ".atomic/extensions"), { recursive: true });
mkdirSync(agent, { recursive: true });
for (const [file, directory] of [["nested-fallback-workflow.ts", "workflows"], ["nested-discovery-provider.ts", "extensions"]]) {
	copyFileSync(join(repo, "test/integration/fixtures", file), join(project, ".atomic", directory, file));
}
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("ATOMIC_") || key.startsWith("PI_") || key === "NODE_TEST_CONTEXT") delete env[key];
Object.assign(env, { NODE_ENV: "production", ATOMIC_CODING_AGENT_DIR: agent, ATOMIC_CODING_AGENT_SESSION_DIR: join(evidence, "sessions"), ATOMIC_SKIP_VERSION_CHECK: "1", NESTED_DISCOVERY_STATE_DIR: evidence, NESTED_FALLBACK_CONTROL: process.argv[3] ?? "fallback", DBOS_SYSTEM_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/unreachable" });
if (probeTop) env.NESTED_COLD_TOP_PROBE = "1";
console.log("BUILD_SHA", execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim());
const cli = spawn(process.execPath, [join(repo, "packages/coding-agent/dist/cli.js"), "--mode", "rpc", "--approve", "--offline", "--no-session", "--provider", "nested-discovery-fixture", "--model", "fixture"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
const frames = [];
let buffered = "";
let exited = false;
cli.on("exit", (code, signal) => { exited = true; console.log("CLI_EXIT", JSON.stringify({ code, signal })); });
cli.stderr.on("data", (data) => {
	appendFileSync(join(evidence, "stderr.log"), data);
	process.stderr.write(data);
	appendFileSync(join(evidence, "stderr-events.jsonl"), `${JSON.stringify({ at: Date.now(), text: data.toString() })}\n`);
});
cli.stdout.on("data", (data) => {
	appendFileSync(join(evidence, "stdout.jsonl"), data);
	buffered += data;
	const lines = buffered.split("\n");
	buffered = lines.pop();
	for (const line of lines) { try { frames.push(JSON.parse(line)); } catch {} }
});
async function waitFor(predicate, label) {
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		assert.equal(exited, false, `CLI exited: ${label}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`Timed out: ${label}; inspect ${evidence}`);
}
let sequence = 0;
async function prompt(message) {
	const id = `step-${++sequence}`;
	cli.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
	await waitFor(() => frames.some((f) => f.type === "response" && f.id === id), id);
}
async function call(name, arguments_) {
	const before = frames.length;
	await prompt(`fixture-call ${JSON.stringify({ name, arguments: arguments_ })}`);
	await waitFor(() => frames.slice(before).some((f) => f.type === "agent_end"), `${name} turn`);
	const result = frames.slice(before).find((f) => f.type === "tool_execution_end" && f.toolName === name)?.result;
	assert.ok(result, `missing ${name} tool result`);
	appendFileSync(join(evidence, "public-results.jsonl"), `${JSON.stringify({ name, arguments: arguments_, result })}\n`);
	assert.ok(!result.isError, JSON.stringify(result));
	return result;
}
async function workflowCall(args) {
	const result = await call("workflow", { ...args, format: "json" });
	return JSON.parse(result.content.find((c) => c.type === "text").text);
}
try {
	// get_state waits for the RPC session, without loading Intercom or publishing authority.
	cli.stdin.write(`${JSON.stringify({ id: "ready", type: "get_state" })}\n`);
	await waitFor(() => frames.some((frame) => frame.type === "response" && frame.id === "ready"), "root session ready");
	if (cold) console.log("COLD_ROOT: no Intercom call before workflow launch");
	else await call("intercom", { action: "status" });
	await prompt("/workflow nested-fallback-fixture");
	let topRoute;
	if (probeTop) {
		await waitFor(() => existsSync(join(evidence, "top-hold")), "first stage model reached after session_start");
		const topStatus = await workflowCall({ action: "status" });
		await call("intercom", { action: "join", group: `workflow:${topStatus.runs[0].runId}` });
		const directory = await call("intercom", { action: "list" });
		topRoute = directory.details.workflowStages?.find((stage) => stage.stageName === "top-reviewer" && stage.lifecycle === "running" && stage.sessionId);
		assert.ok(topRoute, "first cold stage has an acknowledged live owner before any stage Intercom tool call");
		const sent = await call("intercom", { action: "send", to: topRoute.target, message: "cold first-stage delivery" });
		assert.equal(sent.details.delivered, true, JSON.stringify(sent));
		writeFileSync(join(evidence, "top-release"), "release\n");
		console.log("PASS first cold stage live registration and delivery", topRoute.target);
	}
	await waitFor(() => existsSync(join(evidence, "holds.jsonl")) && readFileSync(join(evidence, "holds.jsonl"), "utf8").trim().split("\n").length === 2, "both grandchild stages running after fallback");
	const status = await workflowCall({ action: "status" });
	const root = status.runs[0].runId;
	await call("intercom", { action: "join", group: `workflow:${root}` });
	let routes;
	await waitFor(async () => {
		const directory = await call("intercom", { action: "list" });
		routes = directory.details.workflowStages?.filter((stage) => stage.stageName === "reviewer" && stage.lifecycle === "running" && stage.sessionId);
		return routes?.length === 2;
	}, "both grandchild owners registered");
	assert.equal(new Set(routes.map((r) => r.target)).size, 2);
	assert.equal(new Set(routes.map((r) => r.runId)).size, 2);
	const listing = await workflowCall({ action: "stages", runId: root });
	assert.equal(listing.stages.length, 5);
	for (const summary of listing.stages) {
		const detail = await workflowCall({ action: "stage", runId: root, stageId: summary.id });
		assert.equal(detail.runId === root ? detail.stage.id : `${detail.runId}:${detail.stage.id}`, summary.id);
	}
	for (const route of routes) {
		const sent = await call("intercom", { action: "send", to: route.target, message: `canonical ${route.runId}` });
		assert.equal(sent.details.delivered, true, JSON.stringify(sent));
	}
	writeFileSync(join(evidence, "release"), "release\n");
	await waitFor(async () => (await workflowCall({ action: "status", runId: root })).detail?.status === "completed", "nested fallback completion");
	for (const summary of listing.stages) {
		const { stage } = await workflowCall({ action: "stage", runId: root, stageId: summary.id });
		assert.equal(stage.status, "completed");
		assert.deepEqual(stage.modelAttempts, process.argv[3] === "primary"
			? [{ model: "nested-discovery-fixture/fixture", success: true }]
			: [{ model: "nested-discovery-fixture/failing", success: false, error: "429 rate limit exceeded" }, { model: "nested-discovery-fixture/fixture", success: true }]);
	}
	for (const route of routes) {
		const reply = await call("intercom", { action: "ask", to: route.target, message: "reply with fixture answer" });
		assert.match(JSON.stringify(reply), /exact retained reviewer answer/);
	}
	if (topRoute) {
		const reply = await call("intercom", { action: "ask", to: topRoute.target, message: "reply with fixture answer" });
		assert.match(JSON.stringify(reply), /exact retained reviewer answer/);
	}
	const attempts = readFileSync(join(evidence, "model-attempts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(attempts.filter((attempt) => attempt.model === "fixture" && attempt.text === "fixture-hold").length, 2);
	for (const route of routes) {
		assert.ok(attempts.some((attempt) => attempt.text.startsWith("**📨 From ") && attempt.text.endsWith(`canonical ${route.runId}`)), "recipient provider consumed canonical message");
	}
	if (topRoute) assert.ok(attempts.some((attempt) => attempt.text.startsWith("**📨 From ") && attempt.text.endsWith("cold first-stage delivery")), "first-stage provider consumed message");
	if (process.argv[3] === "primary") assert.equal(attempts.filter((attempt) => attempt.model === "failing").length, 0);
	else assert.ok(attempts.filter((attempt) => attempt.model === "failing").length >= 5);
	console.log("PASS nested child/grandchild completion, distinct canonical delivery and retained replies", root);
} finally {
	writeFileSync(join(evidence, "release"), "release\n");
	if (probeTop) writeFileSync(join(evidence, "top-release"), "release\n");
	cli.stdin.end();
	await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	if (!exited) cli.kill("SIGTERM");
	await waitFor(() => exited, "CLI exit");
	const stderr = existsSync(join(evidence, "stderr.log")) ? readFileSync(join(evidence, "stderr.log"), "utf8") : "";
	assert.doesNotMatch(stderr, /heavy initialization failed|duplicate owner|different-active-session/i);
}
