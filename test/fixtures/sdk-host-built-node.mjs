import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const DURABLE_PHASE_TIMEOUT_MS = 30_000;

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
const diagnostics = [];
const progression = [];
const callbacks = [];
let previousProgress;
let pollCount = 0;
let lastPoll;
const observeProgress = (details) => {
	const state = {
		runs: details.runs.map(({ runId, status, phase, lastProgressAt, awaitingInputCount }) => ({ runId, status, phase, lastProgressAt, awaitingInputCount })),
		snapshots: details.snapshots.map((run) => ({
			id: run.id, status: run.status, phase: run.phase, lastProgressAt: run.lastProgressAt,
			stages: run.stages.map(({ id, name, status, startedAt, endedAt, awaitingInputSince, pendingPrompt }) => ({ id, name, status, startedAt, endedAt, awaitingInputSince, promptId: pendingPrompt?.id })),
			toolNodes: (run.toolNodes ?? []).map(({ id, name, status, startedAt, endedAt }) => ({ id, name, status, startedAt, endedAt })),
		})),
	};
	lastPoll = { observedAt: Date.now(), poll: ++pollCount, ...state };
	const serialized = JSON.stringify(state);
	if (serialized !== previousProgress) {
		previousProgress = serialized;
		if (progression.length === 64) progression.shift();
		progression.push(lastPoll);
	}
};
const confirmAnswer = Promise.withResolvers();
const answer = async (kind, options, value) => {
	identities.push(options);
	const { requestId, sessionId, workflowRunId, workflowStageId } = options;
	callbacks.push({ kind, event: "invoked", observedAt: Date.now(), requestId, sessionId, workflowRunId, workflowStageId });
	try { return await value; }
	finally { callbacks.push({ kind, event: "returned", observedAt: Date.now(), requestId }); }
};
const text = "  durable text  ";
const options = {
	cwd,
	agentDir: join(cwd, "agent"),
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager: SettingsManager.inMemory(),
	builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
	extensionBindings: { onDiagnostic: (entry) => diagnostics.push(entry) },
};
const bindings = {
	onDiagnostic: options.extensionBindings.onDiagnostic,
	humanInput: {
		input: async (_title, _placeholder, options) => answer("input", options, text),
		confirm: async (_title, _message, options) => answer("confirm", options, confirmAnswer.promise),
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
	const pendingDeadline = Date.now() + DURABLE_PHASE_TIMEOUT_MS;
	let pending;
	do {
		pending = (await tool.execute("pending", { action: "status" }, new AbortController().signal)).details;
		observeProgress(pending);
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
		observeProgress(retained);
		assert.equal(retained.runs[0]?.status, "running", JSON.stringify(retained));
		assert.equal(retained.runs[0]?.awaitingInputCount, 1, JSON.stringify(retained));
		callbacks.push({ event: "bindings-installing", observedAt: Date.now() });
		await session.bindExtensions(bindings);
		callbacks.push({ event: "bindings-installed", observedAt: Date.now() });
		const confirmDeadline = Date.now() + DURABLE_PHASE_TIMEOUT_MS;
		let details;
		let confirmRequest;
		let confirmStage;
		do {
			details = (await tool.execute("confirm-ready", { action: "status" }, new AbortController().signal)).details;
			observeProgress(details);
			confirmRequest = callbacks.find((entry) => entry.kind === "confirm" && entry.event === "invoked");
			const run = details.snapshots.find((entry) => entry.id === confirmRequest?.workflowRunId);
			confirmStage = run?.stages.find((entry) => entry.id === confirmRequest?.workflowStageId && entry.pendingPrompt?.kind === "confirm");
			if (confirmStage) break;
			await sleep(20);
		} while (Date.now() < confirmDeadline);
		assert.ok(confirmStage, JSON.stringify({ phase: "confirm-readiness", confirmDeadline, details, callbacks, progression }));
		assert.equal(confirmRequest.sessionId, identities[0].sessionId);
		assert.equal(confirmRequest.workflowRunId, identities[0].workflowRunId);
		assert.notEqual(confirmRequest.workflowStageId, identities[0].workflowStageId);
		assert.notEqual(confirmRequest.requestId, identities[0].requestId);
		assert.equal(details.runs.find((entry) => entry.runId === confirmRequest.workflowRunId)?.awaitingInputCount, 1);
		assert.equal(readFileSync(join(cwd, "receipts.jsonl"), "utf8"), `${JSON.stringify({ text })}\n`);
		assert.equal(existsSync(join(cwd, "effects.jsonl")), false);
		callbacks.push({ event: "confirm-ready", observedAt: Date.now(), requestId: confirmRequest.requestId, promptId: confirmStage.pendingPrompt.id });
		confirmAnswer.resolve(true);
		const deadline = Date.now() + DURABLE_PHASE_TIMEOUT_MS;
		do {
			details = (await tool.execute("status", { action: "status" }, new AbortController().signal)).details;
			observeProgress(details);
			if (details.runs[0]?.status === "completed") break;
			await sleep(20);
		} while (Date.now() < deadline);
		if (details.runs[0]?.status !== "completed") {
			const observedAt = Date.now();
			const sideEffects = Object.fromEntries(["receipts.jsonl", "effects.jsonl"].map((file) => [
				file, existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : null,
			]));
			const runId = details.runs[0]?.runId;
			const checkpointPrefix = `${runId}:checkpoint:`;
			let checkpointRows;
			let databaseActivity;
			let databaseLocks;
			let checkpointReadError;
			let client;
			try {
				const { Client } = createRequire(import.meta.resolve("@bastani/atomic"))("pg");
				client = new Client({
					host: "127.0.0.1", port: metadata.server.port, user: "postgres", password: "atomic",
					database: "atomic_workflows_dbos_sys", ssl: false,
					connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000,
				});
				client.on("error", () => {});
				await client.connect();
				checkpointRows = (await client.query(
					`SELECT workflow_uuid, status, name, created_at, updated_at,
					 left(inputs::text, 4096) AS inputs, left(output::text, 4096) AS output,
					 left(error::text, 2048) AS error FROM dbos.workflow_status
					 WHERE workflow_uuid = $1 OR starts_with(workflow_uuid, $2)
					 ORDER BY created_at DESC, workflow_uuid LIMIT 64`,
					[runId, checkpointPrefix],
				)).rows;
				databaseActivity = (await client.query(
					`SELECT pid, application_name, state, wait_event_type, wait_event,
					 xact_start, query_start, state_change, pg_blocking_pids(pid) AS blocking_pids,
					 left(query, 1024) AS query FROM pg_stat_activity
					 WHERE datname = current_database() AND pid <> pg_backend_pid()
					 ORDER BY query_start LIMIT 32`,
				)).rows;
				databaseLocks = (await client.query(
					`SELECT l.pid, l.locktype, l.mode, l.granted, l.relation::regclass::text AS relation,
					 l.classid, l.objid, l.objsubid, l.transactionid
					 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
					 WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
					 ORDER BY l.granted, l.pid, l.locktype LIMIT 64`,
				)).rows;
			} catch (error) {
				checkpointReadError = String(error);
			} finally {
				await client?.end().catch((error) => { checkpointReadError ??= String(error); });
			}
			console.error(JSON.stringify({ host: "built-node", observedAt, deadline, checkpointReadAt: Date.now(), sideEffects, details, progression, lastPoll, callbacks, checkpointPrefix, checkpointRows, databaseActivity, databaseLocks, checkpointReadError, diagnostics }));
		}
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
	confirmAnswer.resolve(false);
	await session.dispose();
	rmSync(cwd, { recursive: true, force: true });
}
