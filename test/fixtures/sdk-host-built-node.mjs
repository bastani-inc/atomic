import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = process.env.ATOMIC_MANAGED_TEST_HOME;
assert.ok(home && resolve(homedir()) === resolve(home) && process.env.USERPROFILE === home, "built host fixture requires a disposable managed HOME");
assert.ok(home.startsWith(tmpdir()) && home.includes("atomic-real-postgres-"), "requires RealPostgresHome");
assert.equal(process.env.DBOS_SYSTEM_DATABASE_URL, undefined);
assert.equal(process.env.PGPORT, "0", "Docker fallback must be disabled");
const metadata = JSON.parse(readFileSync(join(home, ".atomic", "postgres", "v18.shared", "cluster.json"), "utf8"));
assert.equal(String(metadata.server.port), process.env.ATOMIC_POSTGRES_PORT);
const { AgentSessionRuntime, createAgentSession, createAgentSessionServices, SessionManager, SettingsManager } = await import("@bastani/atomic");

// #3105: actual package export and built builtin assets under non-TTY Node.
assert.equal(process.versions.bun, undefined);
assert.ok(import.meta.resolve("@bastani/atomic").endsWith("/dist/index.js"));
assert.ok(!process.stdin.isTTY && !process.stdout.isTTY);
const cwd = mkdtempSync(join(tmpdir(), "atomic-built-host-"));
const source = readFileSync(new URL("./sdk-host-durable-workflow.ts", import.meta.url));
const hash = createHash("sha256").update(source).digest("hex");
const directory = join(cwd, ".atomic", "workflows");
mkdirSync(directory, { recursive: true });
const definition = join(directory, "sdk-host-durable.ts");
writeFileSync(definition, source);
process.env.ATOMIC_FAULT_TEST_HOME = cwd;
const identities = [];
const text = "  durable text  ";
const options = {
	cwd,
	agentDir: join(cwd, "agent"),
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager: SettingsManager.inMemory(),
	builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
};
const bindings = {
	humanInput: {
		input: async (_title, _placeholder, options) => { identities.push(options); return text; },
		confirm: async (_title, _message, options) => { identities.push(options); return true; },
		select: async () => undefined,
		editor: async () => undefined,
		questionnaire: async () => ({ answers: [], cancelled: true }),
	},
};
// #3105: only public session disposal may release this host's workflow resources.
const replacementFailure = process.argv.includes("--replacement-failure");
const services = replacementFailure ? await createAgentSessionServices(options) : undefined;
const { session } = await createAgentSession({ ...options, ...(services ? { resourceLoader: services.resourceLoader, modelRuntime: services.modelRuntime } : {}) });
const failure = new Error("replacement rejected before session construction");
const runtime = services ? new AgentSessionRuntime(session, services, async () => { throw failure; }) : undefined;
try {
	await session.prompt("/workflow sdk-host-durable --no-picker");
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool);
	const pendingDeadline = Date.now() + 10_000;
	let pending;
	do {
		pending = (await tool.execute("pending", { action: "status" }, new AbortController().signal)).details;
		if (pending.runs[0]?.awaitingInputCount === 1) break;
		await sleep(20);
	} while (Date.now() < pendingDeadline);
	assert.equal(pending.runs[0]?.awaitingInputCount, 1, JSON.stringify(pending));
	assert.equal(pending.runs[0]?.status, "running");
	assert.match(JSON.stringify(pending), /"promptKind":"input"/);
	assert.equal(existsSync(join(cwd, "effects.jsonl")), false);
	if (runtime) {
		await assert.rejects(runtime.newSession(), (error) => error === failure);
		await runtime.dispose();
		console.log(JSON.stringify({ host: "built-node", replacementFailed: true, initiallyPending: true, disposed: true }));
	} else {
		// #3105: starting and closing a sibling must leave this pending owner alive.
		const { session: sibling } = await createAgentSession({ ...options, sessionManager: SessionManager.inMemory(cwd) });
		await sibling.dispose();
		const retained = (await tool.execute("retained", { action: "status" }, new AbortController().signal)).details;
		assert.equal(retained.runs[0]?.status, "running", JSON.stringify(retained));
		assert.equal(retained.runs[0]?.awaitingInputCount, 1, JSON.stringify(retained));
		await session.bindExtensions(bindings);
		const deadline = Date.now() + 10_000;
		let details;
		do {
			details = (await tool.execute("status", { action: "status" }, new AbortController().signal)).details;
			if (details.runs[0]?.status === "completed") break;
			await sleep(20);
		} while (Date.now() < deadline);
		assert.equal(details.runs[0]?.status, "completed", JSON.stringify(details));
		assert.deepEqual(details.snapshots[0].result, { text, approved: true });
		assert.equal(identities.length, 2);
		assert.notEqual(identities[0].requestId, identities[1].requestId);
		for (const identity of identities) {
			assert.ok(identity.sessionId && identity.workflowRunId && identity.workflowStageId);
		}
		assert.equal(readFileSync(join(cwd, "receipts.jsonl"), "utf8"), `${JSON.stringify({ text })}\n`);
		assert.equal(readFileSync(join(cwd, "effects.jsonl"), "utf8"), `${JSON.stringify({ text })}\n`);
		assert.equal(createHash("sha256").update(readFileSync(definition)).digest("hex"), hash);
		console.log(JSON.stringify({ host: "built-node", initiallyPending: true, hash, result: details.snapshots[0].result, effects: 1 }));
	}
} finally {
	await session.dispose();
	rmSync(cwd, { recursive: true, force: true });
}
