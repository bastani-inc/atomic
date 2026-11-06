/**
 * What a forked root's pool asks its coordinator to claim when it queues a child (#4321), and how a refused claim
 * comes back. The coordinator process is a stand-in that records each command; the root, its journal and its pool
 * are real.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import type { BoundWorkspace } from "../../packages/coding-agent/src/index.js";
import { ForkSessionClaimError, isForkSessionClaimError } from "../../packages/workflows/src/durable/fork-errors.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { PoolSessionClaim } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { failedCoordinatorReply } from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { DispatchSnapshots } from "../../packages/workflows/src/workers/dispatch-snapshot.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

interface FakeCoordinator {
	readonly sent: Record<string, unknown>[];
}

const coordinators = vi.hoisted((): FakeCoordinator[] => []);
/** What the stand-in coordinator answers an `enqueue` with: a failed reply, as the coordinator process sends it. */
const enqueueFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	return {
		...actual,
		fork(_modulePath: string, _args: readonly string[], _options: ForkOptions) {
			const sent: Record<string, unknown>[] = [];
			const child = Object.assign(new EventEmitter(), {
				pid: 535_353,
				connected: true,
				exitCode: null as number | null,
				signalCode: null as string | null,
				stderr: new PassThrough(),
				sent,
				send(message: Record<string, unknown>, callback?: (error: Error | null) => void) {
					sent.push(message);
					callback?.(null);
					const id = message.id as number;
					// Every message crosses the process boundary as JSON.
					const reply = (value: object) =>
						setImmediate(() => child.emit("message", JSON.parse(JSON.stringify(value))));
					if (message.kind === "prepare")
						reply({ kind: "reply", id, value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });
					else if (message.kind === "start" || message.kind === "close") reply({ kind: "reply", id });
					else if (message.kind === "enqueue")
						// Loaded once the mock is in place: the codec behind it imports this module.
						void import("../../packages/workflows/src/workers/coordinator-protocol.js").then(
							({ failedCoordinatorReply: failed }) =>
								reply(failed(id, enqueueFailure.error ?? new Error("the stand-in coordinator queues nothing"))),
						);
					return true;
				},
				disconnect() {
					child.connected = false;
					child.exitCode = 0;
					setImmediate(() => child.emit("exit", 0, null));
				},
				kill() {
					return true;
				},
			});
			coordinators.push(child);
			return child;
		},
	};
});

afterEach(() => {
	coordinators.length = 0;
	enqueueFailure.error = undefined;
	vi.restoreAllMocks();
});

const { work, boundary } = poolWorkFixture();
const childRun = { ...boundary.topology!.boundary!.child };
const childPath = fileURLToPath(new URL("../fixtures/pool-heartbeat-child.ts", import.meta.url));

function stageCheckpoint(
	checkpointId: string,
	replayKey: string,
	extra: Partial<Extract<DurableCheckpoint, { kind: "stage" }>> = {},
): DurableCheckpoint {
	return { kind: "stage", workflowId: "root", checkpointId, name: "stage", replayKey, completedAt: 1, ...extra };
}

/**
 * The root's own checkpoints and its child's, as a forked root's journal holds them: the claims are the child's stage
 * sessions under its scope, once each, and nothing else.
 */
const recorded: readonly DurableCheckpoint[] = [
	stageCheckpoint("stage:plan", "stage:plan:1", {
		sessionId: "root-session",
		topology: { version: 1, stageId: "plan", parentIds: [], run: { runId: "root", runName: "root" } },
	}),
	stageCheckpoint(`${work.scope}0:session:a`, `${work.scope}0:stage:a`, {
		sessionId: "neighbour-session",
		topology: { version: 1, stageId: "a", parentIds: [], run: childRun },
	}),
	{
		kind: "tool",
		workflowId: "root",
		checkpointId: `${work.scope}:tool:1`,
		name: "tool",
		argsHash: `${work.scope}:args`,
		output: "saved",
		completedAt: 1,
		topology: { version: 1, nodeId: "tool", parentIds: [], ordinal: 0, order: 0, run: childRun },
	},
	stageCheckpoint(`${work.scope}:stage:quiet`, `${work.scope}:stage:quiet:1`, {
		output: "no session",
		topology: { version: 1, stageId: "quiet", parentIds: [], run: childRun },
	}),
	stageCheckpoint(`${work.scope}:session:runless`, `${work.scope}:stage:runless:1`, {
		sessionId: "runless-session",
		topology: { version: 1, stageId: "runless", parentIds: [] },
	}),
	stageCheckpoint(`${work.scope}:session:implement:1`, `${work.scope}:stage:implement:1`, {
		sessionId: "copy",
		topology: { version: 1, stageId: "implement", parentIds: [], run: childRun },
	}),
	stageCheckpoint(`${work.scope}:stage:implement`, `${work.scope}:stage:implement:1`, {
		sessionId: "copy",
		output: "implemented",
		topology: { version: 1, stageId: "implement", parentIds: [], run: childRun },
	}),
];

async function rootPool(registration: object, checkpoints: readonly DurableCheckpoint[] = recorded) {
	const directory = makeTempDirectory("local-pool-fork-claims-");
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
		...registration,
	});
	await backend.commitCheckpoint(boundary);
	for (const checkpoint of checkpoints) await backend.commitCheckpoint(checkpoint);
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
	});
	await pool.prepare("root");
	const reads = vi.spyOn(backend, "readCheckpoints");
	/** Queues the child, and returns how its run ended and the `enqueue` command the coordinator received. */
	const queueChild = async (extra: Pick<RunOpts, "workspace"> = {}) => {
		const outcome = await pool
			.run(child, work.inputs as never, {
				runId: work.childRunId,
				cwd: directory,
				parentRun: { runId: "root", stageId: work.boundaryId, rootRunId: "root" },
				durableScope: { rootWorkflowId: "root", scopePrefix: work.scope },
				...extra,
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		const command = coordinators.at(-1)!.sent.find((message) => message.kind === "enqueue") as
			| {
					readonly claimSessions?: readonly PoolSessionClaim[];
					readonly descriptor: { readonly execution: Readonly<Record<string, unknown>> };
			  }
			| undefined;
		assert.ok(command !== undefined, "the child was queued");
		return { outcome, command };
	};
	return {
		directory,
		reads,
		queueChild,
		async close() {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		},
	};
}

test("a forked root's pool claims each of its child's stage sessions under the child's scope once, from one scoped read (#4321)", async () => {
	const f = await rootPool({ forkedFrom: { runId: "source" } });
	try {
		const { command } = await f.queueChild();
		assert.deepEqual(command.claimSessions, [
			{ sessionId: "copy", replayKey: `${work.scope}:stage:implement:1`, runId: work.childRunId },
		]);
		assert.deepEqual(f.reads.mock.calls, [["root", work.scope]]);
	} finally {
		await f.close();
	}
});

test("a root that is not a fork claims nothing and reads none of its child's checkpoints to do so (#4321)", async () => {
	const f = await rootPool({});
	try {
		const { command } = await f.queueChild();
		assert.equal("claimSessions" in command, false);
		assert.deepEqual(f.reads.mock.calls, []);
	} finally {
		await f.close();
	}
});

test("a forked root whose child recorded no stage session claims nothing (#4321)", async () => {
	const f = await rootPool(
		{ forkedFrom: { runId: "source" } },
		recorded.filter((checkpoint) => checkpoint.kind !== "stage" || checkpoint.sessionId !== "copy"),
	);
	try {
		const { command } = await f.queueChild();
		assert.equal("claimSessions" in command, false);
		assert.deepEqual(f.reads.mock.calls, [["root", work.scope]]);
	} finally {
		await f.close();
	}
});

test("a claim the coordinator refuses fails the child with the same ForkSessionClaimError (#4321)", async () => {
	const f = await rootPool({ forkedFrom: { runId: "source" } });
	const refused = new ForkSessionClaimError({
		reason: "missing",
		sessionId: "copy",
		rootRunId: "root",
		childRunId: work.childRunId,
		scope: work.scope,
		replayKey: `${work.scope}:stage:implement:1`,
		stageRunId: work.childRunId,
	});
	enqueueFailure.error = refused;
	try {
		const { outcome } = await f.queueChild();
		assert.ok(isForkSessionClaimError(outcome), String(outcome));
		let claim: unknown = outcome;
		while (!(claim instanceof ForkSessionClaimError) && claim instanceof Error) claim = claim.cause;
		assert.ok(claim instanceof ForkSessionClaimError);
		assert.deepEqual(claim.fields, refused.fields);
		assert.equal(claim.message, refused.message);
		assert.equal(failedCoordinatorReply(1, refused).kind, "reply");
	} finally {
		await f.close();
	}
});

test("a pool that is not shared queues a child bound to a workspace without its binding or a snapshot of its worktree (#4492)", async () => {
	const f = await rootPool({});
	const captures = vi.spyOn(DispatchSnapshots.prototype, "capture");
	try {
		const bound: BoundWorkspace = {
			kind: "bound-workspace",
			version: 1,
			repo: f.directory,
			repository: f.directory,
			branch: "feat/child",
			worktree: f.directory,
			base: "main",
			baseCommit: "c",
			sandbox: "workspace-write",
			remotes: [],
			head: "h",
			tree: "t",
			envHash: "e",
		};
		const { command } = await f.queueChild({ workspace: bound });
		const { execution } = command.descriptor;
		assert.deepEqual(execution.workspace, bound, "it runs in its workspace on this machine");
		assert.equal("workspaceBinding" in execution, false, "only a shared pool places a child by its binding");
		assert.equal("workspaceSnapshot" in execution, false);
		assert.equal(captures.mock.calls.length, 0, "and captures nothing for other hosts");
	} finally {
		await f.close();
	}
});
