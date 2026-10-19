import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	bunExecutable,
	copyFileSync,
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readText,
	sleep,
	spawnSyncCollect,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

/**
 * Structural: two real source CLI children each load every builtin extension and then run a project
 * workflow, followed by two more children that must fail during startup.
 */
const REAL_RPC_CHILDREN_TIMEOUT_MS = 240_000;
/** Per-step deadline once a child answers. */
const STEP_TIMEOUT_MS = 60_000;

const repositoryRoot = join(moduleDir(import.meta.url), "../..");
const cliPath = join(repositoryRoot, "packages/coding-agent/src/cli.ts");
const adapterPath = join(repositoryRoot, "test/fixtures/storage-adapter.ts");
const workflowFixture = join(moduleDir(import.meta.url), "fixtures/issue-3783-storage-workflow.ts");
const WORKFLOW_NAME = "issue-3783-storage";
const SECRET = "issue-3783-secret-value";

/** Inherited storage selections would decide the outcome instead of the scenario. */
const CLEARED_STORAGE_ENV = {
	ATOMIC_STORAGE: "",
	ATOMIC_SESSIONS_STORAGE: "",
	ATOMIC_WORKFLOWS_JOURNAL: "",
	ATOMIC_WORKFLOW_JOURNAL_PATH: "",
	ATOMIC_CODING_AGENT_SESSION_DIR: "",
};

interface ChildEvidence {
	readonly sessionId: string;
	readonly listedSessions: readonly string[];
	readonly runId: string;
	readonly listedRuns: readonly string[];
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, client: RpcClient): Promise<T> {
	const deadline = Date.now() + STEP_TIMEOUT_MS;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}.\nCLI stderr:\n${client.getStderr()}`);
		await sleep(100);
	}
}

async function driveChild(client: RpcClient, label: string): Promise<ChildEvidence> {
	await client.start();
	await client.setSessionName(`${label} conversation`);
	const { sessionId } = await client.getState();
	await client.prompt(`/workflow ${WORKFLOW_NAME}`);
	const run = await waitFor(
		async () => {
			const runs = await client.listWorkflowRuns();
			const finished = runs.find((candidate) => candidate.name === WORKFLOW_NAME && candidate.status !== "running");
			return finished;
		},
		`${label}'s workflow run to finish`,
		client,
	);
	assert.equal(run.status, "completed", `${label} run ${run.runId}: ${run.error ?? ""}\n${client.getStderr()}`);
	const listedSessions = (await client.listSessions()).map((session) => session.id);
	const listedRuns = (await client.listWorkflowRuns()).map((summary) => summary.runId);
	return { sessionId, listedSessions, runId: run.runId, listedRuns };
}

async function storedSessions(project: string, path: string): Promise<string[]> {
	const store = await resolveSessionStore(project, { sessionStore: { kind: "sqlite", path } });
	try {
		return (await SessionManager.list(project, store)).map((session) => session.id);
	} finally {
		await store.close();
	}
}

async function storedRuns(path: string): Promise<string[]> {
	const journal = await resolveRunJournal({ journal: { path } });
	try {
		return (await journal.listRuns()).map((run) => run.runId);
	} finally {
		await journal.close();
	}
}

test(
	"an RPC child keeps sessions and workflow runs in its ATOMIC_STORAGE adapter while a sibling keeps its settings (#3783)",
	async () => {
		const root = makeTempDirectory("process-storage-rpc-");
		const atomicHome = join(root, "atomic");
		const agentDir = join(atomicHome, "agent");
		const project = join(root, "project");
		const settingsPath = join(agentDir, "settings.json");
		const selectedStore = join(root, "selected", "process-store.sqlite");
		const settingsStore = join(atomicHome, "settings-store.sqlite");
		await writeFileEnsuringDir(
			settingsPath,
			`${JSON.stringify({ onboardedVersion: "0.0.0", storage: { path: "settings-store.sqlite" } }, null, 2)}\n`,
		);
		await writeFileEnsuringDir(join(project, ".atomic/workflows/.keep"), "");
		copyFileSync(workflowFixture, join(project, ".atomic/workflows/issue-3783-storage-workflow.ts"));
		const settingsBefore = await readText(settingsPath);
		const childOptions = (env: Record<string, string>) =>
			new RpcClient({
				cliPath,
				cwd: project,
				runtimeExecutable: bunExecutable(),
				args: ["--approve", "--offline"],
				env: {
					...CLEARED_STORAGE_ENV,
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ANTHROPIC_API_KEY: "test-only-no-requests",
					...env,
				},
			});
		const selected = childOptions({
			ATOMIC_STORAGE: JSON.stringify({
				adapter: adapterPath,
				options: { path: selectedStore },
				secrets: { marker: { env: "ISSUE_3783_SECRET" } },
			}),
			ISSUE_3783_SECRET: SECRET,
		});
		const unselected = childOptions({});
		try {
			const [fromEnv, fromSettings] = await Promise.all([
				driveChild(selected, "env-selected"),
				driveChild(unselected, "settings-selected"),
			]);
			assert.notEqual(fromEnv.sessionId, fromSettings.sessionId);
			assert.deepEqual(fromEnv.listedSessions, [fromEnv.sessionId]);
			assert.deepEqual(fromSettings.listedSessions, [fromSettings.sessionId]);
			assert.deepEqual(fromEnv.listedRuns, [fromEnv.runId]);
			assert.deepEqual(fromSettings.listedRuns, [fromSettings.runId]);
			await Promise.all([selected.stop(), unselected.stop()]);

			assert.deepEqual(await storedSessions(project, selectedStore), [fromEnv.sessionId]);
			assert.deepEqual(await storedSessions(project, settingsStore), [fromSettings.sessionId]);
			assert.deepEqual(await storedRuns(selectedStore), [fromEnv.runId]);
			assert.deepEqual(await storedRuns(settingsStore), [fromSettings.runId]);
			const database = await openNodeSqliteDatabase(selectedStore);
			try {
				const probes = await database.all("SELECT options FROM adapter_probe");
				assert.equal(probes.length, 1, "sessions and the journal share one adapter database");
				assert.ok(String(probes[0]?.options).includes(SECRET), "the { env } secret reached the adapter");
			} finally {
				await database.close();
			}
			assert.equal(fileExistsSync(join(atomicHome, "workflows", "journal.sqlite")), false);
			assert.equal(fileExistsSync(join(atomicHome, "storage.sqlite")), false);
			assert.equal(await readText(settingsPath), settingsBefore);
		} finally {
			await Promise.all([selected.stop(), unselected.stop()]);
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	REAL_RPC_CHILDREN_TIMEOUT_MS,
);

test(
	"an RPC child with an invalid ATOMIC_STORAGE or unreadable --storage-file fails at startup naming it (#3783)",
	async () => {
		const root = makeTempDirectory("process-storage-rpc-invalid-");
		const agentDir = join(root, "agent");
		await writeFileEnsuringDir(join(agentDir, "settings.json"), JSON.stringify({ onboardedVersion: "0.0.0" }));
		try {
			for (const [label, args, env, field] of [
				[
					"env",
					[],
					{ ATOMIC_STORAGE: `{"adapter":"x","options":{"token":"${SECRET}"` },
					"ATOMIC_STORAGE (invalid-json)",
				],
				["file", ["--storage-file", "missing-selection.json"], {}, "--storage-file (unreadable-file)"],
			] as const) {
				const result = spawnSyncCollect([bunExecutable(), cliPath, "--mode", "rpc", "--offline", ...args], {
					cwd: root,
					env: { ...process.env, ...CLEARED_STORAGE_ENV, ATOMIC_CODING_AGENT_DIR: agentDir, ...env },
					timeout: STEP_TIMEOUT_MS,
				});
				const stderr = result.stderr.toString();
				assert.notEqual(result.exitCode, 0, `${label}: ${stderr}`);
				assert.ok(stderr.includes(`Invalid storage configuration: ${field}`), `${label}: ${stderr}`);
				assert.equal(stderr.includes(SECRET), false, `${label} leaked the selection value`);
			}
			assert.equal(fileExistsSync(join(root, "workflows", "journal.sqlite")), false);
		} finally {
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	REAL_RPC_CHILDREN_TIMEOUT_MS,
);
