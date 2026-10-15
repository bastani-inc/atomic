import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Client, Pool } from "pg";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { DbosCheckpointEnvelope } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { getDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";
import { serializeFixtureError } from "../helpers/fixture-error.js";

const ROOT_WORKFLOW_COMPLETION_TIMEOUT_MS = 30_000;
const ROOT_WORKFLOW_POLL_INTERVAL_MS = 50;
const objectIdentities = new WeakMap<object, number>();
const backendIdentities: { name: string; state: string; backend: number | null; registry: number | null }[] = [];
let nextObjectIdentity = 1;
// Diagnostics go to stderr only; the parent surfaces them when a request times out (#3586).
const DIAGNOSTIC_FIRST_SNAPSHOT_MS = 60_000;
const DIAGNOSTIC_SNAPSHOT_INTERVAL_MS = 30_000;
const DIAGNOSTIC_QUERY_TIMEOUT_MS = 5_000;

function phase(label: string, detail?: unknown): void {
	const at = `+${(performance.now() / 1000).toFixed(1)}s`;
	console.error(`[cross-cwd ${at}] ${label}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

async function databaseSnapshot(databaseUrl: string): Promise<void> {
	const owner = getDbosProcessOwner();
	phase("owner", {
		state: owner.state,
		leases: owner.leases.size,
		executorId: owner.executorId,
		launching: owner.launchPromise !== undefined,
		shuttingDown: owner.shutdownPromise !== undefined,
		fenceClosed: owner.executorFence?.closed,
		fenceInvalidated: owner.executorFence?.invalidated,
	});
	const client = new Client({
		connectionString: databaseUrl,
		connectionTimeoutMillis: DIAGNOSTIC_QUERY_TIMEOUT_MS,
		statement_timeout: DIAGNOSTIC_QUERY_TIMEOUT_MS,
		application_name: "cross-cwd-diagnostics",
	});
	client.on("error", () => {});
	try {
		await client.connect();
		const queries = {
			workflows:
				"SELECT workflow_uuid, name, status, executor_id, updated_at FROM dbos.workflow_status ORDER BY created_at DESC LIMIT 40",
			ownerGeneration: "SELECT * FROM dbos.atomic_owner_generation",
			activity: `SELECT pid, application_name, state, wait_event_type, wait_event,
				 round(extract(epoch FROM now() - xact_start) * 1000) AS xact_ms,
				 round(extract(epoch FROM now() - state_change) * 1000) AS state_ms, left(query, 160) AS query
				 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
			locks: "SELECT locktype, mode, granted, pid, classid, objid, relation::regclass::text AS relation FROM pg_locks WHERE locktype = 'advisory' OR NOT granted",
		};
		for (const [name, sql] of Object.entries(queries)) {
			try {
				phase(`db ${name}`, (await client.query(sql)).rows);
			} catch (error) {
				phase(`db ${name} failed`, String(error));
			}
		}
	} catch (error) {
		phase("db snapshot failed", String(error));
	} finally {
		await client.end().catch(() => {});
	}
}

function startDiagnosticWatchdog(databaseUrl: string): () => void {
	let snapshot: Promise<void> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	const take = () => {
		snapshot ??= databaseSnapshot(databaseUrl).finally(() => {
			snapshot = undefined;
		});
	};
	const first = setTimeout(() => {
		take();
		interval = setInterval(take, DIAGNOSTIC_SNAPSHOT_INTERVAL_MS);
	}, DIAGNOSTIC_FIRST_SNAPSHOT_MS);
	return () => {
		clearTimeout(first);
		clearInterval(interval);
	};
}

function objectIdentity(value: object | undefined): number | null {
	if (value === undefined) return null;
	let identity = objectIdentities.get(value);
	if (identity === undefined) {
		identity = nextObjectIdentity++;
		objectIdentities.set(value, identity);
	}
	return identity;
}

const home = process.env.ATOMIC_FAULT_TEST_HOME;
assert.ok(home);
const bundlePath = join(home, "workflows.bundle.mjs");
const built = await Bun.build({
	entrypoints: [resolve(import.meta.dir, "../../packages/workflows/src/extension/index.ts")],
	target: "node",
	format: "esm",
	external: [
		"@bastani/atomic",
		"@bastani/atomic/*",
		"@bastani/atomic-natives",
		"@bastani/pi-ai",
		"@bastani/pi-ai/*",
		"@earendil-works/*",
		"@mariozechner/*",
		"typebox",
		"typebox/*",
		"@sinclair/typebox",
		"@sinclair/typebox/*",
		"proper-lockfile",
		"@opentelemetry/*",
		"winston",
		"winston-transport",
	],
	define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
});
assert.ok(built.success, built.logs.map(String).join("\n"));
await writeFile(bundlePath, await built.outputs[0].text());
phase("bundle built");

async function launch(name: string, databaseUrl: string) {
	const cwd = join(home!, name);
	const agentDir = join(home!, "agent");
	await mkdir(join(cwd, ".atomic", "workflows"), { recursive: true });
	await writeFile(
		join(cwd, ".atomic", "workflows", "noop.ts"),
		`import { workflow } from "@bastani/atomic/workflows";
export default workflow({ name: "noop", description: "One durable tool", inputs: {}, outputs: {},
 run: async ctx => { await ctx.tool("step", {}, async () => "ok"); return {}; } });
`,
	);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		builtinPackagePaths: [],
		noExtensions: true,
		additionalExtensionPaths: [bundlePath],
	});
	phase(`${name}: loading resources`);
	await resourceLoader.reload();
	phase(`${name}: creating session`);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	phase(`${name}: session created`, { dbosState: getDbosProcessOwner().state });
	try {
		const ended = Promise.withResolvers<{ status: string; runId: string; error?: string }>();
		const unsubscribe = session.subscribe((event) => {
			if (
				event.type === "entry_appended" &&
				event.entry.type === "custom" &&
				event.entry.customType === "workflow.run.end"
			) {
				phase(`${name}: run.end`, event.entry.data);
				ended.resolve(event.entry.data as { status: string; runId: string; error?: string });
			}
		});
		try {
			phase(`${name}: prompt sent`);
			await session.prompt("/workflow noop --no-picker");
			phase(`${name}: prompt returned`);
			const result = await ended.promise;
			assert.equal(result.status, "completed", JSON.stringify({ name, ...result }));
			const owner = getDbosProcessOwner();
			backendIdentities.push({
				name,
				state: owner.state,
				backend: objectIdentity(owner.active?.backend),
				registry: objectIdentity(owner.wrappers),
			});
			const sql = new Pool({ connectionString: databaseUrl });
			try {
				const queryRows = () =>
					sql.query<{
						workflow_uuid: string;
						name: string;
						status: string;
						envelope: DbosCheckpointEnvelope | null;
					}>(
						`SELECT workflow_uuid, name, status,
						 CASE WHEN output::jsonb->>'__dbos_serializer' = 'superjson'
						 THEN output::jsonb->'json' ELSE output::jsonb END AS envelope
						 FROM dbos.workflow_status WHERE workflow_uuid = $1 OR starts_with(workflow_uuid, $2)`,
						[result.runId, `${result.runId}:checkpoint:`],
					);
				const deadline = Date.now() + ROOT_WORKFLOW_COMPLETION_TIMEOUT_MS;
				let rows = await queryRows();
				while (
					!rows.rows.some(
						(row) => row.workflow_uuid === result.runId && ["SUCCESS", "ERROR", "CANCELLED"].includes(row.status),
					) &&
					Date.now() < deadline
				) {
					await new Promise((resolve) => setTimeout(resolve, ROOT_WORKFLOW_POLL_INTERVAL_MS));
					rows = await queryRows();
				}
				phase(`${name}: root poll finished`, {
					root: rows.rows.find((row) => row.workflow_uuid === result.runId)?.status ?? null,
					remainingMs: deadline - Date.now(),
				});
				const diagnostics = JSON.stringify({ name, runId: result.runId, backendIdentities, rows: rows.rows });
				assert.ok(
					rows.rows.some((row) => row.name === "atomicWorkflowHandle" && row.status === "SUCCESS"),
					`run must complete using the durable DBOS backend: ${diagnostics}`,
				);
				const tools = rows.rows.filter(
					(row) =>
						row.name === "atomicWorkflowCheckpoint" &&
						row.status === "SUCCESS" &&
						row.workflow_uuid.startsWith(`${result.runId}:checkpoint:tool:`) &&
						row.envelope?.kind === "tool",
				);
				assert.equal(tools.length, 1, `run must persist exactly one completed tool checkpoint: ${diagnostics}`);
				const tool = tools[0];
				const envelope = tool.envelope;
				assert.ok(envelope);
				assert.equal(envelope.__dbos_checkpoint__, "__dbos_checkpoint__");
				assert.equal(envelope.name, "step");
				assert.equal(envelope.hasOutput, true);
				assert.equal(envelope.output, "ok");
				assert.ok(envelope.completedAt > 0);
				assert.equal(typeof envelope.argsHash, "string");
				assert.ok(envelope.argsHash);
				assert.equal(envelope.checkpointId, `tool:${envelope.argsHash}`);
				assert.equal(tool.workflow_uuid, `${result.runId}:checkpoint:${envelope.checkpointId}`);
				return {
					...result,
					toolCheckpoint: {
						workflowId: tool.workflow_uuid,
						checkpointId: envelope.checkpointId,
						name: envelope.name,
						output: envelope.output,
					},
				};
			} finally {
				await sql.end();
			}
		} finally {
			unsubscribe();
		}
	} finally {
		phase(`${name}: disposing session`);
		await session.dispose();
		phase(`${name}: session disposed`, { dbosState: getDbosProcessOwner().state });
	}
}

for await (const line of createInterface({ input: process.stdin })) {
	const { id, command, sql: databaseUrl } = JSON.parse(line) as { id: number; command: string; sql: string };
	try {
		if (command === "exit") {
			console.log(JSON.stringify({ id, result: {} }));
			process.exit(0);
		}
		assert.equal(command, "run");
		backendIdentities.length = 0;
		process.env.DBOS_SYSTEM_DATABASE_URL = databaseUrl;
		const stopWatchdog = startDiagnosticWatchdog(databaseUrl);
		try {
			phase("run received");
			const first = await launch("first", databaseUrl);
			const second = await launch("second", databaseUrl);
			console.log(JSON.stringify({ id, result: { first, second } }));
		} finally {
			stopWatchdog();
		}
	} catch (error) {
		console.log(JSON.stringify({ id, error: serializeFixtureError(error) }));
	}
}
