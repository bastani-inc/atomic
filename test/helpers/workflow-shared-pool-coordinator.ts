/** The fixture shared by the workflow-shared-pool-coordinator*.test.ts files: a root run and a worker host over one shared journal. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";
import type { WorktreeSnapshotSettingsInput } from "../../packages/coding-agent/src/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { type SharedPoolRoot, SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import type { run } from "../../packages/workflows/src/engine/run.js";
import type { StageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type {
	CoordinatorEvent,
	CoordinatorInbound,
	CoordinatorPort,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import type { AdmissionConfiguration } from "../../packages/workflows/src/workers/resource-admission.js";
import type { RestoreBackoff } from "../../packages/workflows/src/workers/restore-backoff.js";
import type { WorkspaceBinding } from "../../packages/workflows/src/workers/workspace-binding.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";

export const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
export const childPath = fileURLToPath(new URL("../fixtures/shared-pool-child.ts", import.meta.url));
export const stubWorker = fileURLToPath(new URL("../fixtures/shared-pool-stub-worker.mjs", import.meta.url));
export const PREFIX = "acme_";
/** Each test forks stub worker processes and loads the child definition: structural cost, not slowness. */
export const COORDINATOR_TEST_TIMEOUT_MS = 120_000;
export const binding: WorkspaceBinding = {
	remotes: ["https://example.invalid/r.git"],
	head: "h1",
	tree: "t1",
	envHash: "e1",
};

/** The brokered question the stub worker's stage waits on, as it answers a read of it (#4391). */
export const STUB_QUESTION = {
	promptId: "q1",
	kind: "ask_user_question",
	params: {
		questions: [
			{
				question: "Ship it?",
				header: "Ship",
				multiSelect: false,
				options: [
					{ label: "yes", description: "Ship it now" },
					{ label: "no", description: "Hold it" },
				],
			},
		],
	},
};

/** The receipt of a user message whose delivery op is "error-busy": the stub's stage fails it with "busy" (#4391). */
export const USER_MESSAGE_ERROR_RECEIPT = JSON.stringify({
	ok: false,
	error: { name: "Error", message: "busy", fields: {} },
});

export interface Fixture {
	readonly directory: string;
	readonly log: string;
	readonly backend: JournalDurableBackend;
	readonly hostJournal: RunJournal;
	readonly pool: LocalWorkerPool;
	readonly shared: SqlSharedPool;
	claims(): string[][];
	/** `[host, work id, "released" | "refused"]` for each place an attempt gave back while its stage waited released. */
	placesReleased(): string[][];
	/** The start options of every worker forked so far, as each received them. */
	starts(): Record<string, unknown>[];
	root(): Promise<SharedPoolRoot>;
	close(): Promise<void>;
}

export async function fixture(
	label: string,
	options: {
		workspace?: WorkspaceBinding;
		/** Records what the root binds its children to in the shared journal before the pool starts, and returns it. */
		bind?: (backend: JournalDurableBackend) => Promise<WorkspaceBinding>;
		/** The worktree of the root's binding on its host, which the root captures when it starts (#4492). */
		workspaceWorktree?: string;
		/** The root's worktree snapshot settings. */
		snapshots?: WorktreeSnapshotSettingsInput;
		claimWindowMs?: number;
		admission?: AdmissionConfiguration;
		maxLoadPerCpu?: number;
		maxWorkerRssBytes?: number;
		leaseMs?: number;
		stageControlRegistry?: StageControlRegistry;
		stageInputTimeoutMs?: number;
	},
): Promise<Fixture> {
	const directory = makeLibsqlDirectory(`${label}-`);
	const log = join(directory, "stub.log");
	writeFileSync(log, "");
	vi.stubEnv("SHARED_POOL_STUB_LOG", log);
	const selection = {
		adapter: libsql,
		options: { url: pathToFileURL(join(directory, "shared.db")).href },
		prefix: PREFIX,
	};
	const journal = await resolveRunJournal({ agentDir: join(directory, "root", "agent"), journal: selection });
	const hostJournal = await resolveRunJournal({ agentDir: join(directory, "host", "agent"), journal: selection });
	const backend = await JournalDurableBackend.open(journal);
	const bound = options.bind === undefined ? options.workspace : await options.bind(backend);
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "boundChild",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		rootId: "root",
		durable: poolDurableJournal(journal),
		shared: {
			stateDirectory: join(directory, "root", "state"),
			host: "root-host",
			claimWindowMs: options.claimWindowMs ?? 60_000,
		},
		...(bound === undefined ? {} : { workspace: bound }),
		...(options.workspaceWorktree === undefined ? {} : { workspaceWorktree: options.workspaceWorktree }),
		...(options.snapshots === undefined ? {} : { snapshots: options.snapshots }),
		...(options.admission === undefined ? {} : { admission: options.admission }),
		...(options.maxLoadPerCpu === undefined ? {} : { maxLoadPerCpu: options.maxLoadPerCpu }),
		...(options.maxWorkerRssBytes === undefined ? {} : { maxWorkerRssBytes: options.maxWorkerRssBytes }),
		...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
		...(options.stageControlRegistry === undefined ? {} : { stageControlRegistry: options.stageControlRegistry }),
		...(options.stageInputTimeoutMs === undefined ? {} : { stageInputTimeoutMs: options.stageInputTimeoutMs }),
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
		workerEntry: stubWorker,
		coordinator: "in-process",
	});
	const shared = await SqlSharedPool.open(hostJournal, await openSqlPoolQueue(hostJournal));
	return {
		directory,
		log,
		backend,
		hostJournal,
		pool,
		shared,
		claims: () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter(
					(line) =>
						line !== "" &&
						!/^(answer|start|question|user|intercom|received) /.test(line) &&
						!line.startsWith("place-released "),
				)
				.map((line) => line.split(" ")),
		placesReleased: () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("place-released "))
				.map((line) => line.split(" ").slice(1)),
		starts: () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("start "))
				.map((line) => JSON.parse(line.slice("start ".length)) as Record<string, unknown>),
		async root() {
			for (;;) {
				const [root] = await shared.roots();
				if (root !== undefined && root.status === "running") return root;
				await sleep(25);
			}
		},
		async close() {
			await pool.close().catch(() => {});
			await backend.close();
			await hostJournal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		},
	};
}

/** The start options of every stub worker that logged to `log`. */
export function loggedStarts(log: string): Record<string, unknown>[] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("start "))
		.map((line) => JSON.parse(line.slice("start ".length)) as Record<string, unknown>);
}

/** A coordinator port that goes nowhere, as a worker host's does; it keeps the health messages it is given. */
export function quietPort(health: string[]): CoordinatorPort<CoordinatorEvent, CoordinatorInbound> {
	return {
		send(event) {
			if (event.kind === "health") health.push(event.message);
		},
		onMessage() {},
		onClose() {},
		async close() {},
	};
}

export function fanOut(count: number) {
	return async (child: Parameters<typeof run>[0]) => {
		const outcomes: (string | Error)[] = [];
		const parent = workflow({
			name: "shared-pool-coordinator-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const results = await Promise.allSettled(
					Array.from({ length: count }, () => ctx.workflow(child as never, { inputs: {} })),
				);
				for (const result of results)
					outcomes.push(result.status === "fulfilled" ? result.value.status : (result.reason as Error));
				return {};
			},
		});
		return { parent, outcomes };
	};
}

export async function satellite(
	f: Fixture,
	root: SharedPoolRoot,
	placement: {
		prefer?: (binding: WorkspaceBinding) => Promise<string | undefined>;
		restore?: (binding: WorkspaceBinding, options: { readonly signal: AbortSignal }) => Promise<string>;
		restoreBackoff?: RestoreBackoff;
	},
	failures: Error[] = [],
	host = "host-b",
	workers = 2,
): Promise<PoolCoordinator> {
	const coordinator = new PoolCoordinator(quietPort([]));
	await coordinator.attachSatellite({
		root: root.root,
		lease: root.lease,
		journal: f.hostJournal,
		config: root.config,
		sources: root.config.definitions,
		workers,
		durable: poolDurableJournal(f.hostJournal),
		stateDirectory: join(f.directory, "host", "state"),
		workerEntry: stubWorker,
		placement: {
			host,
			...placement,
			detached: (reason) => {
				if (reason !== undefined) failures.push(reason);
			},
			placementFailed: (error) => failures.push(error),
		},
	});
	return coordinator;
}
