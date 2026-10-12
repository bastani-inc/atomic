import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Pool } from "pg";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { DbosCheckpointEnvelope } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { getDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";

const ROOT_WORKFLOW_COMPLETION_TIMEOUT_MS = 30_000;
const ROOT_WORKFLOW_POLL_INTERVAL_MS = 50;
const objectIdentities = new WeakMap<object, number>();
const backendIdentities: { name: string; state: string; backend: number | null; registry: number | null }[] = [];
let nextObjectIdentity = 1;

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
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	try {
		const ended = Promise.withResolvers<{ status: string; runId: string; error?: string }>();
		const unsubscribe = session.subscribe((event) => {
			if (
				event.type === "entry_appended" &&
				event.entry.type === "custom" &&
				event.entry.customType === "workflow.run.end"
			) {
				ended.resolve(event.entry.data as { status: string; runId: string; error?: string });
			}
		});
		try {
			await session.prompt("/workflow noop --no-picker");
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
		await session.dispose();
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
		const first = await launch("first", databaseUrl);
		const second = await launch("second", databaseUrl);
		console.log(JSON.stringify({ id, result: { first, second } }));
	} catch (error) {
		console.log(JSON.stringify({ id, error: String(error) }));
	}
}
