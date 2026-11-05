/**
 * A workflow reload, `/workflow reload` and a preserving host `/reload` alike, replaces the session's workflow runtime
 * while pooled roots keep running on local workers. Neither may touch what those roots hold: the root's run lease
 * (holder and epoch, still renewed afterwards) and every child's work lease (worker, generation and epoch). A real
 * SDK session with the workflows extension, a real SQLite journal and real local worker processes.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { releaseDurableBackendsHeldBy } from "../../packages/workflows/src/durable/backend-process-owner.js";
import workflowExtension from "../../packages/workflows/src/extension/index.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import { currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { sleep } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend } from "../helpers/store-backend.js";
import { decisionChatModel, registeredDecisionRuntime } from "../helpers/structured-output.js";

const CHILDREN = 2;
const childPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));
/** One pool's cold start, plus the root's lease renewals awaited after the reloads. */
const POOL = poolTestBudgetMs(1);
/** Long enough for the root process to renew its lease at least once after the reloads. */
const RENEWAL_WAIT_MS = 2 * STAGE_SESSION_HEARTBEAT_INTERVAL_MS;
const TIMEOUT_MS = POOL.timeoutMs + RENEWAL_WAIT_MS;

interface RootLease {
	readonly holder: string;
	readonly epoch: number;
	readonly renewedAt: number;
}

interface WorkLease {
	readonly id: string;
	readonly state: string;
	readonly generation: number;
	readonly worker: string | null;
	readonly epoch: number;
	readonly expiresAt: number;
}

function pooledRootSource(directory: string): string {
	return `import { loadWorkerWorkflow, workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "pooled-root",
	description: "A root over pooled children",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		const child = await loadWorkerWorkflow(${JSON.stringify(childPath)}, "resumedChild");
		const results = await Promise.all(
			Array.from({ length: ${CHILDREN} }, (_, index) =>
				ctx.workflow(child, { inputs: { directory: ${JSON.stringify(directory)}, index } }),
			),
		);
		for (const result of results) if (result.status !== "completed") throw new Error(JSON.stringify(result));
		return {};
	},
});
`;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string, budget: AbortSignal) {
	while (!(await predicate())) {
		if (budget.aborted) throw new Error(`Timed out waiting for ${what}`);
		await sleep(50);
	}
}

test.skipIf(process.platform === "win32")(
	"a workflow reload and a host reload leave live pooled roots' root and work leases alone",
	async () => {
		const cwd = process.cwd();
		const root = await mkdtemp(join(tmpdir(), "atomic-pool-reload-leases-"));
		const project = join(root, "project");
		const agentDir = join(root, "home/.atomic/agent");
		const journalPath = join(root, "journal.sqlite");
		const definition = join(project, ".atomic/workflows/pooled-root.ts");
		// The session's own workflow store, read once the session exists.
		let store: Store | undefined;
		const findRoot = () => store?.runs().find((run) => run.name === "pooled-root");
		let session: AgentSession | undefined;
		let database: DatabaseSync | undefined;
		const db = (): DatabaseSync => {
			assert.ok(database, "the journal is open");
			return database;
		};
		const rootLease = (runId: string): RootLease => {
			const row = db().prepare("SELECT holder_id, epoch, renewed_at FROM wf_leases WHERE run_id = ?").get(runId) as {
				holder_id: string;
				epoch: number;
				renewed_at: number;
			};
			return { holder: row.holder_id, epoch: Number(row.epoch), renewedAt: Number(row.renewed_at) };
		};
		const workLeases = (runId: string): WorkLease[] =>
			(
				db()
					.prepare(
						"SELECT id, state, generation, worker, epoch, expires_at FROM wf_runs_work WHERE root = ? ORDER BY id",
					)
					.all(runId) as {
					id: string;
					state: string;
					generation: number;
					worker: string | null;
					epoch: number;
					expires_at: number;
				}[]
			).map((row) => ({
				id: row.id,
				state: row.state,
				generation: Number(row.generation),
				worker: row.worker,
				epoch: Number(row.epoch),
				expiresAt: Number(row.expires_at),
			}));
		const startedChildren = async () => (await readdir(root)).filter((name) => name.startsWith("started-"));
		const budget = AbortSignal.timeout(POOL.waitMs + RENEWAL_WAIT_MS);
		// Everything from here on is undone in `finally`, including a setup step that throws.
		try {
			await mkdir(dirname(definition), { recursive: true });
			await mkdir(agentDir, { recursive: true });
			await writeFile(definition, pooledRootSource(root));
			process.chdir(project);
			vi.stubEnv("HOME", join(root, "home"));
			vi.stubEnv("USERPROFILE", join(root, "home"));
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", journalPath);
			// The session opens the SQLite journal its settings select, which every worker process opens too.
			configureCurrentTestStoreBackend(undefined);
			const { runtime: modelRuntime } = await registeredDecisionRuntime(() => {
				throw new Error("no model is asked");
			});
			const settingsManager = SettingsManager.inMemory({
				workflows: {
					// Selected by settings, not passed as an object: every worker process opens the same journal.
					journal: { path: journalPath },
					localWorkers: { count: CHILDREN, definitions: [{ path: childPath, exportName: "resumedChild" }] },
				},
				compaction: { enabled: false },
				sessionSummary: { enabled: false },
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd: project,
				agentDir,
				settingsManager,
				builtinPackagePaths: [],
				noExtensions: true,
				extensionFactories: [(pi) => workflowExtension(pi as unknown as ExtensionAPI)],
			});
			await resourceLoader.reload();
			({ session } = await createAgentSession({
				cwd: project,
				agentDir,
				modelRuntime,
				model: decisionChatModel,
				builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(project),
			}));
			store = currentWorkflowStore();
			database = new DatabaseSync(journalPath);
			database.exec("PRAGMA busy_timeout = 5000");
			await session.bindExtensions({});
			const launchRunner = session.extensionRunner;
			const command = launchRunner.getCommand("workflow");
			assert.ok(command, "the /workflow command is registered on the real host");
			await command.handler("pooled-root --no-picker", launchRunner.createCommandContext());
			await waitUntil(
				async () => (await startedChildren()).length === CHILDREN,
				"every pooled child to run on a worker",
				budget,
			);
			const rootId = findRoot()?.id;
			assert.ok(rootId, "the pooled root is running");
			const leaseBefore = rootLease(rootId);
			const workBefore = workLeases(rootId);
			assert.equal(workBefore.length, CHILDREN);
			for (const work of workBefore) assert.equal(work.state, "leased", JSON.stringify(work));

			// `/workflow reload`: rediscovers definitions and replaces the session's workflow runtime.
			const reloadCommand = session.extensionRunner.getCommand("workflow");
			assert.ok(reloadCommand);
			await reloadCommand.handler("reload", session.extensionRunner.createCommandContext());
			// A preserving host `/reload`: retires the extension generation and starts the next one.
			await session.reload({ reason: "reload", failOnExtensionErrors: true });
			assert.notEqual(session.extensionRunner, launchRunner, "the host reload replaced the runner");
			assert.equal(findRoot()?.status, "running", "a preserving reload keeps the pooled root in flight");

			const reloadedAt = rootLease(rootId).renewedAt;
			await waitUntil(
				() => rootLease(rootId).renewedAt > reloadedAt,
				"the pooled root's lease to be renewed after the reloads",
				budget,
			);
			const leaseAfter = rootLease(rootId);
			assert.equal(leaseAfter.holder, leaseBefore.holder, "the root's lease holder is unchanged");
			assert.equal(leaseAfter.epoch, leaseBefore.epoch, "the root's lease epoch is unchanged");
			const workAfter = workLeases(rootId);
			assert.deepEqual(
				workAfter.map(({ expiresAt: _expiresAt, ...lease }) => lease),
				workBefore.map(({ expiresAt: _expiresAt, ...lease }) => lease),
				"every child keeps its work lease: same worker, generation and epoch, still leased",
			);
			for (const [index, work] of workAfter.entries())
				assert.ok(work.expiresAt >= workBefore[index]!.expiresAt, "a work lease is never shortened");

			await writeFile(join(root, "release"), "");
			await waitUntil(() => findRoot()?.endedAt !== undefined, "the pooled root to finish", budget);
			const finished = findRoot();
			assert.equal(finished?.status, "completed", JSON.stringify(finished?.error));
			assert.equal(store.runs().filter((run) => run.parentRunId === rootId).length, CHILDREN);
			assert.equal((await startedChildren()).length, CHILDREN, "no child ran again on another worker");
		} finally {
			// Let a still-running root finish, then stop its pool and worker processes with the session's backend.
			if (findRoot() !== undefined && findRoot()?.endedAt === undefined) {
				await writeFile(join(root, "release"), "").catch(() => {});
				await waitUntil(
					() => findRoot()?.endedAt !== undefined,
					"the pooled root to settle before disposal",
					AbortSignal.timeout(POOL.waitMs),
				).catch(() => {});
			}
			database?.close();
			await session?.dispose();
			if (store !== undefined) await releaseDurableBackendsHeldBy(store).catch(() => {});
			vi.unstubAllEnvs();
			process.chdir(cwd);
			await rm(root, { recursive: true, force: true });
		}
	},
	TIMEOUT_MS,
);
