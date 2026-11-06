import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	GitUnavailableError,
	isGitUnavailableError,
	WorkspaceRestoreError,
} from "../../packages/coding-agent/src/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSqlPoolQueue, type SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	readSharedPoolStats,
	SqlSharedPool,
	STAGE_INPUT_PROMPT_ANSWER,
	workerHost,
} from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import {
	JournalInvalidTextError,
	type Lease,
	RUN_EVENT_TYPES,
	StaleLeaseError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import { isStaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	isStaleStageLeaseError,
	StaleStageLeaseError,
	WorkspaceRestoreUnavailableError,
	workspaceBindingIdentity,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { type WorkspaceBinding, workspaceAffinityKey } from "../../packages/workflows/src/workers/workspace-binding.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { sleep } from "../helpers/runtime.js";

const header = { runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" };
const PREFIX = "acme_";
const binding: WorkspaceBinding = {
	remotes: ["https://example.invalid/repo.git"],
	head: "1111111111111111111111111111111111111111",
	tree: "2222222222222222222222222222222222222222",
	envHash: "env-1",
};
const definition = { definition: "fixture/child", digest: "sha256:child" };

/** A prefixed journal in a libSQL file, the adapter shared placement is for, with a root that holds its lease. */
async function fixture() {
	const directory = makeLibsqlDirectory();
	const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "journal.db")).href });
	const journal = await SqlRunJournal.open(database, { prefix: PREFIX });
	await journal.createRun(header);
	const acquired = await journal.acquire(header.runId, "coordinator");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(lease, 60_000);
	return {
		database,
		journal,
		lease,
		queue,
		async shared() {
			return SqlSharedPool.open(journal, queue);
		},
		async tables(): Promise<string[]> {
			return (await database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((row) =>
				String(row.name),
			);
		},
		async close() {
			await journal.close();
			await database.close();
			await removeLibsqlDirectory(directory);
		},
	};
}

async function claimed(queue: SqlPoolQueue, lease: Lease, name: string, worker = "host-a/worker-1") {
	const { work, boundary } = poolWorkFixture(name);
	await queue.enqueue(lease, work, boundary);
	const held = await queue.claim(lease, worker, [definition], 60_000);
	assert.ok(held, "the work is claimed");
	return held;
}

test("shared placement keeps the pool's tables in the shared journal, under its prefix, and only when used (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = (await f.tables()).filter((name) => /_pool_(shared|hosts|activity)$|_stage_/.test(name));
		assert.deepEqual(shared, [], "a pool that is not shared creates no shared-placement table");
		await f.shared();
		const tables = await f.tables();
		for (const name of [
			"acme_wf_runs_work",
			"acme_wf_runs_pool",
			"acme_wf_runs_pool_control",
			"acme_wf_runs_pool_shared",
			"acme_wf_runs_pool_hosts",
			"acme_wf_runs_pool_activity",
			"acme_wf_runs_stage_inputs",
			"acme_wf_runs_stage_leases",
			"acme_wf_runs_stage_workspaces",
			"acme_wf_runs_pool_restore_backoffs",
		])
			assert.ok(tables.includes(name), `${name} is in the journal`);
		assert.deepEqual(
			tables.filter((name) => !name.startsWith(PREFIX) && name !== "sqlite_sequence"),
			[],
			"every table carries the journal's prefix",
		);
	} finally {
		await f.close();
	}
});

test("a stage's inputs are taken in order, one at a time, each under a stage lease (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const attempt = await claimed(f.queue, f.lease, "ordered");
		const stage = { runId: attempt.childRunId, stageId: "stage-a" };
		for (const op of ["first", "second", "third"])
			await shared.appendStageInput(f.lease, { work: attempt.id, ...stage, kind: "note", op, payload: op });
		const seen: string[] = [];
		for (;;) {
			const taken = await shared.takeStageInput(f.lease, attempt, stage, 60_000);
			if (taken === undefined) break;
			assert.equal(
				(await shared
					.takeStageInput(f.lease, { ...attempt, worker: "host-b/worker-9" }, stage, 60_000)
					.catch((error: Error) => error)) instanceof StaleStageLeaseError,
				true,
				"a worker that does not hold the stage's work takes nothing",
			);
			assert.deepEqual(
				await shared.takeStageInput(f.lease, attempt, stage, 60_000),
				taken,
				"while an input is in flight the stage's holder is given the same input again, never the next one",
			);
			seen.push(taken.payload);
			await shared.ackStageInput(f.lease, taken, JSON.stringify({ ok: true }));
		}
		assert.deepEqual(seen, ["first", "second", "third"]);
		assert.deepEqual(
			(await shared.stageInputs("root", stage.runId, stage.stageId)).map(({ seq, state }) => [seq, state]),
			[
				[1, "done"],
				[2, "done"],
				[3, "done"],
			],
		);
	} finally {
		await f.close();
	}
});

test("stages run their inputs in parallel: each stage has its own lease (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const attempt = await claimed(f.queue, f.lease, "parallel");
		const one = { runId: attempt.childRunId, stageId: "one" };
		const two = { runId: attempt.childRunId, stageId: "two" };
		await shared.appendStageInput(f.lease, { work: attempt.id, ...one, kind: "note", op: "a", payload: "a" });
		await shared.appendStageInput(f.lease, { work: attempt.id, ...two, kind: "note", op: "b", payload: "b" });
		const first = await shared.takeStageInput(f.lease, attempt, one, 60_000);
		const second = await shared.takeStageInput(f.lease, attempt, two, 60_000);
		assert.equal(first?.payload, "a");
		assert.equal(second?.payload, "b", "a busy stage does not hold up another stage");
		assert.deepEqual(
			(await shared.stagesWithInputs("root", [attempt.id])).map(({ stageId }) => stageId),
			["one", "two"],
		);
	} finally {
		await f.close();
	}
});

test("an idle stage's next input goes to the attempt that holds its work now; the displaced one cannot write (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const first = await claimed(f.queue, f.lease, "displaced", "host-a/worker-1");
		const stage = { runId: first.childRunId, stageId: "stage" };
		await shared.appendStageInput(f.lease, { work: first.id, ...stage, kind: "note", op: "1", payload: "1" });
		await shared.appendStageInput(f.lease, { work: first.id, ...stage, kind: "note", op: "2", payload: "2" });
		const taken = (await shared.takeStageInput(f.lease, first, stage, 60_000))!;
		// Host A's worker is lost: its attempt is released and host B's worker claims the work.
		assert.equal(await f.queue.releaseExited(f.lease, first), true);
		const second = (await f.queue.claim(f.lease, "host-b/worker-1", [definition], 60_000))!;
		assert.equal(second.generation, first.generation + 1);
		const refused = await shared.ackStageInput(f.lease, taken, "{}").catch((error: Error) => error);
		assert.ok(isStaleStageLeaseError(refused));
		assert.equal(refused.code, "stale-stage-lease");
		assert.equal(refused.reason, "attempt-replaced");
		assert.deepEqual([refused.runId, refused.stageId, refused.seq], [stage.runId, stage.stageId, 1]);
		await assert.rejects(shared.renewStageInput(f.lease, taken, 60_000), StaleStageLeaseError);
		await assert.rejects(shared.releaseStageInput(f.lease, taken), StaleStageLeaseError);
		// The new holder takes the stage over once the displaced lease expires, from the input never acknowledged.
		const quick = await shared.takeStageInput(f.lease, second, stage, 60_000);
		assert.equal(quick, undefined, "a live stage lease is not taken over");
		await f.database.run(`UPDATE ${PREFIX}wf_runs_stage_leases SET expires_at = 0`);
		const retaken = (await shared.takeStageInput(f.lease, second, stage, 60_000))!;
		assert.deepEqual([retaken.seq, retaken.payload, retaken.attempt.worker], [1, "1", "host-b/worker-1"]);
		assert.equal(retaken.token, taken.token + 1);
		await shared.ackStageInput(f.lease, retaken, "{}");
		assert.equal((await shared.takeStageInput(f.lease, second, stage, 60_000))?.payload, "2");
	} finally {
		await f.close();
	}
});

test("a stage lease that expired is taken again, and its former holder's acknowledgement is refused (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const attempt = await claimed(f.queue, f.lease, "expired");
		const stage = { runId: attempt.childRunId, stageId: "stage" };
		await shared.appendStageInput(f.lease, { work: attempt.id, ...stage, kind: "note", op: "1", payload: "1" });
		const stale = (await shared.takeStageInput(f.lease, attempt, stage, 1))!;
		await sleep(20);
		const fresh = (await shared.takeStageInput(f.lease, attempt, stage, 60_000))!;
		assert.equal(fresh.seq, stale.seq);
		const refused = await shared.ackStageInput(f.lease, stale, "{}").catch((error: Error) => error);
		assert.ok(refused instanceof StaleStageLeaseError);
		assert.equal(refused.reason, "stage-lease-replaced");
		assert.equal(
			(await shared.stageInputs("root", stage.runId, stage.stageId))[0]?.state,
			"pending",
			"nothing was written",
		);
		await shared.ackStageInput(f.lease, fresh, '{"ok":true}');
		assert.deepEqual(await shared.stageInputs("root", stage.runId, stage.stageId), [
			{ seq: 1, op: "1", kind: "note", state: "done", receipt: '{"ok":true}' },
		]);
	} finally {
		await f.close();
	}
});

test("an input appended again with the same op keeps one place; a release leaves it next (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const attempt = await claimed(f.queue, f.lease, "idempotent");
		const stage = { runId: attempt.childRunId, stageId: "stage" };
		const input = { work: attempt.id, ...stage, kind: "prompt-answer", op: "prompt:p1", payload: "{}" };
		assert.equal(await shared.appendStageInput(f.lease, input), 1);
		assert.equal(await shared.appendStageInput(f.lease, { ...input, payload: "changed" }), 1);
		assert.equal(await shared.appendStageInput(f.lease, { ...input, op: "prompt:p2" }), 2);
		const taken = (await shared.takeStageInput(f.lease, attempt, stage, 60_000))!;
		await shared.releaseStageInput(f.lease, taken);
		const again = (await shared.takeStageInput(f.lease, attempt, stage, 60_000))!;
		assert.deepEqual([again.seq, again.payload], [1, "{}"]);
	} finally {
		await f.close();
	}
});

test("claims place bound work: the root's workers skip it, a host takes exactly the item it chose (#4310)", async () => {
	const f = await fixture();
	try {
		const bound = poolWorkFixture("bound");
		const free = poolWorkFixture("free");
		await f.queue.enqueue(
			f.lease,
			{ ...bound.work, execution: { workspaceBinding: JSON.parse(JSON.stringify(binding)) } },
			bound.boundary,
		);
		await f.queue.enqueue(f.lease, free.work, free.boundary);
		const candidates = await f.queue.readyCandidates(f.lease, [definition], 10);
		assert.deepEqual(
			candidates.map((candidate) => [candidate.workspace?.tree ?? null, candidate.generation]),
			[
				[binding.tree, 0],
				[null, 0],
			],
		);
		assert.deepEqual(await f.queue.readyCandidates(f.lease, [], 10), []);
		const unbound = (await f.queue.claim(f.lease, "root/worker", [definition], 60_000, { kind: "unbound" }))!;
		assert.equal(unbound.boundaryId, "free", "the root's own workers take only unbound work");
		assert.equal(await f.queue.claim(f.lease, "root/worker-2", [definition], 60_000, { kind: "unbound" }), undefined);
		const target = candidates[0]!;
		assert.equal(
			await f.queue.claim(f.lease, "host-b/worker", [definition], 60_000, {
				kind: "work",
				id: target.id,
				generation: target.generation + 1,
			}),
			undefined,
			"a chosen item that changed since it was read is not taken",
		);
		const chosen = (await f.queue.claim(f.lease, "host-b/worker", [definition], 60_000, {
			kind: "work",
			id: target.id,
			generation: target.generation,
		}))!;
		assert.deepEqual([chosen.id, chosen.worker], [target.id, "host-b/worker"]);
		assert.deepEqual((chosen.execution as { workspaceBinding?: WorkspaceBinding }).workspaceBinding, binding);
	} finally {
		await f.close();
	}
});

test("unclaimed work fails only while it is the ready item named (#4310)", async () => {
	const f = await fixture();
	try {
		const { work, boundary } = poolWorkFixture("unclaimed");
		const queued = await f.queue.enqueue(f.lease, work, boundary);
		assert.equal(await f.queue.failUnclaimed(f.lease, { id: queued.id, generation: queued.generation + 1 }), false);
		assert.equal(await f.queue.failUnclaimed(f.lease, queued), true);
		assert.equal((await f.queue.inspect("root"))[0]?.state, "failed");
		assert.equal(await f.queue.failUnclaimed(f.lease, queued), false);
	} finally {
		await f.close();
	}
});

test("stages record their workspace; hosts register; activity of current attempts is relayed; stats count it (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const attempt = await claimed(f.queue, f.lease, "recorded", "host-b/worker-1");
		await shared.recordStageWorkspace(f.lease, attempt, {
			runId: attempt.childRunId,
			stageId: "stage",
			host: "host-b",
			worktree: "/work/tree",
			binding,
		});
		const [record] = await shared.stageWorkspaces("root");
		assert.deepEqual(
			{ ...record, recordedAt: undefined },
			{
				runId: attempt.childRunId,
				stageId: "stage",
				work: attempt.id,
				generation: attempt.generation,
				host: "host-b",
				worktree: "/work/tree",
				binding,
				recordedAt: undefined,
			},
		);
		await assert.rejects(
			shared.recordStageWorkspace(
				f.lease,
				{ ...attempt, generation: 9 },
				{
					runId: attempt.childRunId,
					stageId: "other",
					host: "host-b",
					worktree: "/elsewhere",
					binding: null,
				},
			),
			(error: unknown) => isStaleWorkLeaseError(error) && error.reason === "generation-mismatch",
			"a replaced attempt records nothing",
		);

		assert.equal(await shared.capableHostLive("root", 60_000, workspaceAffinityKey(binding)), false);
		await shared.reportHost({
			host: "host-c",
			labels: {},
			git: "unavailable",
			restore: false,
			workers: 1,
			maxWorkers: 1,
			roots: ["root"],
		});
		assert.equal(
			await shared.capableHostLive("root", 60_000, workspaceAffinityKey(binding)),
			false,
			"a host without git cannot restore",
		);
		await shared.reportHost({
			host: "host-d",
			labels: {},
			git: "system",
			restore: true,
			workers: 1,
			maxWorkers: 1,
			roots: ["another-root"],
		});
		assert.equal(
			await shared.capableHostLive("root", 60_000, workspaceAffinityKey(binding)),
			false,
			"a host that does not serve the root",
		);
		await shared.reportHost({
			host: "host-b",
			labels: { zone: "east" },
			git: "system",
			restore: true,
			workers: 2,
			maxWorkers: 4,
			roots: ["another-root", "root"],
		});
		assert.equal(await shared.capableHostLive("root", 60_000, workspaceAffinityKey(binding)), true);
		await f.database.run(`UPDATE ${PREFIX}wf_runs_pool_hosts SET heartbeat_at = 0`);
		assert.equal(
			await shared.capableHostLive("root", 60_000, workspaceAffinityKey(binding)),
			false,
			"a host that stopped reporting is not live",
		);

		await shared.relayActivity(f.lease, [
			{ work: attempt, runs: '[{"id":"current"}]' },
			{ work: { ...attempt, generation: attempt.generation + 1 }, runs: '[{"id":"stale"}]' },
		]);
		const relayed = await shared.activityAfter("root", 0);
		assert.deepEqual(
			relayed.map((entry) => entry.runs),
			['[{"id":"current"}]'],
		);
		assert.deepEqual(await shared.activityAfter("root", relayed[0]!.version), []);

		const stats = await shared.stats("root");
		assert.deepEqual([stats.ready, stats.leased, stats.completed, stats.failed], [0, 1, 0, 0]);
		assert.deepEqual(
			stats.leases.map((lease) => [lease.childRunId, lease.host]),
			[[attempt.childRunId, "host-b"]],
		);
		assert.ok(stats.leases[0]!.expiresInMs > 0 && stats.leases[0]!.renewedAgoMs >= 0);
		assert.deepEqual(
			stats.hosts.map((host) => [host.host, host.leased, host.labels]),
			[
				["host-b", 1, { zone: "east" }],
				["host-c", 0, {}],
				["host-d", 0, {}],
			],
		);
		await shared.forgetHost("host-c");
		await shared.forgetHost("host-d");
		assert.deepEqual(
			(await shared.registeredHosts()).map((host) => host.host),
			["host-b"],
		);
		assert.equal(workerHost("host-b/worker-1"), "host-b");
		assert.equal(workerHost("a/b/worker"), "a/b");
		assert.equal(workerHost("unshared"), "");
		assert.equal(workerHost("/rooted"), "");
	} finally {
		await f.close();
	}
});

test("a root publishes its shared configuration under its lease, and hosts read it with the root's current lease (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const config = {
			definitions: [{ path: "/defs/child.ts", exportName: "child", digest: "sha256:child" }],
			leaseMs: 30_000,
			heartbeatMs: 7_500,
			startupTimeoutMs: 60_000,
			claimWindowMs: 5_000,
		};
		await shared.publishConfig(f.lease, config);
		const [root] = await shared.roots();
		assert.deepEqual(root?.config, config);
		assert.deepEqual(root?.lease, f.lease);
		assert.equal(root?.status, "running");
		assert.equal(root?.fresh, true);
		assert.equal(root?.budgetBlocked, false, "a root that names no budget block publishes none");
		await assert.rejects(shared.publishConfig({ ...f.lease, epoch: f.lease.epoch + 1 }, config));
		// The root resumes under a newer lease: hosts see it again only once that incarnation publishes its settings.
		await f.database.run(`UPDATE ${PREFIX}wf_leases SET epoch = epoch + 1`);
		const resumed = { ...f.lease, epoch: f.lease.epoch + 1 };
		assert.deepEqual(await shared.roots(), [], "an earlier incarnation's settings are no host's to serve");
		const changed = { ...config, definitions: [{ ...config.definitions[0]!, digest: "sha256:edited" }] };
		await shared.publishConfig(resumed, changed);
		assert.deepEqual(
			(await shared.roots()).map((entry) => [entry.config, entry.lease.epoch]),
			[[changed, resumed.epoch]],
		);
	} finally {
		await f.close();
	}
});

test("stage leases refuse bad durations, unknown stages and a second acknowledgement, and renew forward only (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const attempt = await claimed(f.queue, f.lease, "durations");
		const stage = { runId: attempt.childRunId, stageId: "stage" };
		for (const duration of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
			await assert.rejects(shared.takeStageInput(f.lease, attempt, stage, duration), /positive safe integer/);
		await shared.appendStageInput(f.lease, {
			work: attempt.id,
			...stage,
			kind: STAGE_INPUT_PROMPT_ANSWER,
			op: "1",
			payload: "1",
		});
		assert.equal(STAGE_INPUT_PROMPT_ANSWER, "prompt-answer");
		const refused = await shared
			.takeStageInput(f.lease, { ...attempt, generation: attempt.generation + 1 }, stage, 60_000)
			.catch((error: Error) => error);
		assert.ok(refused instanceof StaleStageLeaseError);
		assert.deepEqual(refused.fields(), {
			reason: "attempt-replaced",
			root: "root",
			runId: stage.runId,
			stageId: "stage",
			seq: null,
		});
		const taken = (await shared.takeStageInput(f.lease, attempt, stage, 60_000))!;
		const renewed = await shared.renewStageInput(f.lease, taken, 120_000);
		assert.ok(renewed.expiresAt > taken.expiresAt, "a renewal moves the stage lease forward");
		assert.deepEqual({ ...renewed, expiresAt: taken.expiresAt }, taken);
		const shorter = await shared.renewStageInput(f.lease, renewed, 1);
		assert.equal(shorter.expiresAt, renewed.expiresAt, "a renewal never shortens the lease");
		const [lease] = await f.database.all(`SELECT expires_at FROM ${PREFIX}wf_runs_stage_leases`);
		assert.equal(Number(lease?.expires_at), renewed.expiresAt);
		await shared.ackStageInput(f.lease, taken, "{}");
		const twice = await shared.ackStageInput(f.lease, taken, "{}").catch((error: Error) => error);
		assert.ok(
			twice instanceof StaleStageLeaseError && twice.reason === "stage-lease-replaced",
			"an input is settled once",
		);
		const unknown = await shared
			.ackStageInput(f.lease, { ...taken, stageId: "never-taken" }, "{}")
			.catch((error: Error) => error);
		assert.ok(unknown instanceof StaleStageLeaseError && unknown.reason === "stage-lease-replaced");
		await assert.rejects(
			shared.appendStageInput(f.lease, {
				work: attempt.id,
				...stage,
				kind: "note",
				op: "bad\u0000op",
				payload: "",
			}),
			(error: Error) => error.name === "JournalInvalidTextError",
		);
		await assert.rejects(
			shared.reportHost({
				host: "nul\u0000host",
				labels: {},
				git: "system",
				restore: false,
				workers: 0,
				maxWorkers: 1,
				roots: [],
			}),
			(error: Error) => error.name === "JournalInvalidTextError",
		);
	} finally {
		await f.close();
	}
});

test("a released input is taken again under a new token; a stage with nothing waiting gives nothing (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const attempt = await claimed(f.queue, f.lease, "release");
		const stage = { runId: attempt.childRunId, stageId: "stage" };
		assert.equal(await shared.takeStageInput(f.lease, attempt, stage, 60_000), undefined);
		assert.deepEqual(await shared.stagesWithInputs("root", []), []);
		await shared.appendStageInput(f.lease, { work: attempt.id, ...stage, kind: "note", op: "1", payload: "1" });
		const taken = (await shared.takeStageInput(f.lease, attempt, stage, 60_000))!;
		await shared.releaseStageInput(f.lease, taken);
		const [idle] = await f.database.all(`SELECT seq, expires_at FROM ${PREFIX}wf_runs_stage_leases`);
		assert.deepEqual([idle?.seq, Number(idle?.expires_at)], [null, 0], "a released stage is idle");
		const again = (await shared.takeStageInput(f.lease, attempt, stage, 60_000))!;
		assert.deepEqual([again.seq, again.token], [taken.seq, taken.token + 1]);
		assert.deepEqual(await shared.stagesWithInputs("root", [attempt.id, "other-work"]), [
			{ work: attempt.id, runId: stage.runId, stageId: "stage" },
		]);
	} finally {
		await f.close();
	}
});

test("host reports and stats say what each host is and holds; activity and roots read as written (#4310)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		assert.deepEqual(await shared.roots(), [], "a root that published no configuration is no host's to serve");
		await shared.publishConfig(f.lease, {
			definitions: [],
			leaseMs: 1,
			heartbeatMs: 1,
			startupTimeoutMs: 1,
			claimWindowMs: 1,
		});
		await f.database.run(`UPDATE ${PREFIX}wf_leases SET renewed_at = 0`);
		assert.equal((await shared.roots())[0]?.fresh, false, "a root that stopped renewing is not fresh");
		await f.journal.renew(f.lease);
		await shared.relayActivity({ ...f.lease, epoch: f.lease.epoch + 1 }, []);
		await shared.reportHost({
			host: "h1",
			labels: { a: "b" },
			git: "provisioned",
			restore: false,
			workers: 3,
			maxWorkers: 5,
			roots: ["root"],
		});
		const [host] = await shared.registeredHosts();
		assert.deepEqual(
			{ ...host, heartbeatAgoMs: 0 },
			{
				host: "h1",
				labels: { a: "b" },
				git: "provisioned",
				restore: false,
				workers: 3,
				maxWorkers: 5,
				roots: ["root"],
				heartbeatAgoMs: 0,
			},
		);
		assert.ok(host!.heartbeatAgoMs >= 0);
		await shared.reportHost({
			host: "h1",
			labels: {},
			git: "system",
			restore: true,
			workers: 0,
			maxWorkers: 5,
			roots: [],
		});
		assert.deepEqual(
			(await shared.registeredHosts()).map((entry) => [entry.git, entry.restore]),
			[["system", true]],
			"a report replaces the host's row",
		);
		await assert.rejects(
			shared.reportHost({
				host: "h\u0000",
				labels: {},
				git: "system",
				restore: false,
				workers: 0,
				maxWorkers: 1,
				roots: [],
			}),
			(error) => error instanceof JournalInvalidTextError && error.field === "key",
		);
		await assert.rejects(
			shared.appendStageInput(f.lease, {
				work: "w",
				runId: "r",
				stageId: "s\u0000",
				kind: "prompt-answer",
				op: "o",
				payload: "{}",
			}),
			(error) => error instanceof JournalInvalidTextError && error.field === "key",
		);
		const { work, boundary } = poolWorkFixture("ready");
		await f.queue.enqueue(f.lease, work, boundary);
		const failing = poolWorkFixture("failing");
		const failed = await f.queue.enqueue(f.lease, failing.work, failing.boundary);
		await f.queue.failUnclaimed(f.lease, failed);
		const stats = await shared.stats("root");
		assert.deepEqual(
			[stats.ready, stats.leased, stats.completed, stats.failed, stats.pendingStageInputs],
			[1, 0, 0, 1, 0],
		);
		const read = await readSharedPoolStats(f.journal, "root");
		assert.deepEqual(
			{ ...read, hosts: read?.hosts.map((entry) => entry.host) },
			{ ...stats, hosts: stats.hosts.map((entry) => entry.host) },
		);
		assert.equal(await readSharedPoolStats(new MemoryRunJournal(), "root"), undefined);
		await assert.rejects(SqlSharedPool.open(new MemoryRunJournal(), f.queue), /requires a SQL run journal/);
		const held = await claimed(f.queue, f.lease, "relayed");
		await shared.relayActivity(f.lease, [{ work: held, runs: "[1]" }]);
		await shared.relayActivity(f.lease, [{ work: held, runs: "[2]" }]);
		const relayed = await shared.activityAfter("root", 0);
		assert.deepEqual(
			relayed.map((entry) => [entry.runs, entry.version]),
			[["[2]", 2]],
			"each relay replaces the work's activity under a new version",
		);
		await shared.recordStageWorkspace(f.lease, held, {
			runId: held.childRunId,
			stageId: "unbound",
			host: "h1",
			worktree: "/w",
			binding: null,
		});
		assert.equal((await shared.stageWorkspaces("root"))[0]?.binding, null);
		const [stored] = await f.database.all(`SELECT binding FROM ${PREFIX}wf_runs_stage_workspaces`);
		assert.equal(stored?.binding, null, "an unbound stage stores no binding, not the text null");
	} finally {
		await f.close();
	}
});

test("an attempt stands only while it holds its unexpired work in the root's current incarnation (#4310)", async () => {
	const f = await fixture();
	try {
		const attempt = await claimed(f.queue, f.lease, "standing");
		const storage = sqlPoolStorage(f.journal)!;
		const standing = (lease: Lease, token: typeof attempt) =>
			storage.transaction((tx) => f.queue.attemptStanding(tx, lease, token));
		assert.equal(typeof (await standing(f.lease, attempt)), "number");
		for (const token of [
			{ ...attempt, generation: attempt.generation + 1 },
			{ ...attempt, worker: "someone-else" },
			{ ...attempt, epoch: attempt.epoch + 1 },
			{ ...attempt, id: "missing" },
		])
			assert.equal(await standing(f.lease, token), undefined, JSON.stringify(token));
		await f.database.run(`UPDATE ${PREFIX}wf_runs_work SET expires_at = 1 WHERE id = ?`, attempt.id);
		assert.equal(await standing(f.lease, attempt), undefined, "an expired attempt does not stand");
		await f.database.run(
			`UPDATE ${PREFIX}wf_runs_work SET expires_at = expires_at + 4000000000000, state = 'completed' WHERE id = ?`,
			attempt.id,
		);
		assert.equal(await standing(f.lease, attempt), undefined, "a completed attempt does not stand");
		const refusedReason = async (token: typeof attempt): Promise<string | undefined> => {
			const refused = await storage
				.transaction((tx) => f.queue.assertAttemptIn(tx, f.lease, token))
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			return isStaleWorkLeaseError(refused) ? refused.reason : undefined;
		};
		assert.equal(await refusedReason(attempt), "not-leased");
		assert.equal(await refusedReason({ ...attempt, id: "missing" }), "missing");
		await f.database.run(
			`UPDATE ${PREFIX}wf_runs_work SET state = 'leased', expires_at = 1 WHERE id = ?`,
			attempt.id,
		);
		assert.equal(await refusedReason(attempt), "expired");
		assert.equal(await refusedReason({ ...attempt, generation: attempt.generation + 1 }), "generation-mismatch");
		assert.equal(await refusedReason({ ...attempt, worker: "someone-else" }), "worker-mismatch");
		assert.equal(await refusedReason({ ...attempt, epoch: attempt.epoch + 1 }), "epoch-mismatch");
		await f.database.run(
			`UPDATE ${PREFIX}wf_runs_work SET expires_at = expires_at + 4000000000000 WHERE id = ?`,
			attempt.id,
		);
		assert.equal(typeof (await storage.transaction((tx) => f.queue.assertAttemptIn(tx, f.lease, attempt))), "number");
		await f.database.run(`UPDATE ${PREFIX}wf_leases SET epoch = epoch + 1`);
		const nextLease = { ...f.lease, epoch: f.lease.epoch + 1 };
		assert.equal(
			await standing(nextLease, attempt),
			undefined,
			"work still held in an earlier incarnation does not stand in the next",
		);
		await f.database.run(`UPDATE ${PREFIX}wf_runs_work SET epoch = epoch + 1 WHERE id = ?`, attempt.id);
		assert.equal(
			await standing(nextLease, attempt),
			undefined,
			"an attempt of an earlier incarnation does not stand in the next",
		);
		assert.equal(typeof (await standing(nextLease, { ...attempt, epoch: nextLease.epoch })), "number");
		assert.equal(typeof (await storage.transaction((tx) => f.queue.assertRootIn(tx, nextLease))), "number");
		await assert.rejects(
			storage.transaction((tx) => f.queue.assertRootIn(tx, f.lease)),
			StaleLeaseError,
		);
	} finally {
		await f.close();
	}
});

test("ready candidates carry a binding only when their child has one, and claims choose among every definition (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	try {
		await journal.createRun(header);
		const acquired = await journal.acquire(header.runId, "coordinator");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const lease = acquired.lease;
		const queue = await openSqlPoolQueue(journal);
		await queue.initialize(lease, 60_000);
		const free = poolWorkFixture("free");
		await queue.enqueue(lease, { ...free.work, definition: "fixture/other" }, free.boundary);
		const [candidate] = await queue.readyCandidates(
			lease,
			[definition, { definition: "fixture/other", digest: "sha256:child" }],
			5,
		);
		assert.equal(candidate !== undefined && "workspace" in candidate, false, "an unbound child has no binding");
		assert.deepEqual(
			await queue.readyCandidates(lease, [definition], 5),
			[],
			"a definition this host lacks is not offered",
		);
		const unbound = await queue.claim(
			lease,
			"w",
			[definition, { definition: "fixture/other", digest: "sha256:child" }],
			60_000,
			{
				kind: "unbound",
			},
		);
		assert.equal(unbound?.boundaryId, "free", "the second of two definitions is matched too");
	} finally {
		await journal.close();
		await database.close();
		await removeLibsqlDirectory(directory);
	}
});

test("a host that backs off from a binding's restore is no capable host for it until its wait ends (#4416)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const key = workspaceAffinityKey(binding);
		const other = workspaceAffinityKey({ ...binding, tree: "3333333333333333333333333333333333333333" });
		const report = (host: string) =>
			shared.reportHost({
				host,
				labels: {},
				git: "system",
				restore: true,
				workers: 1,
				maxWorkers: 1,
				roots: ["root"],
			});
		await report("host-b");
		assert.equal(await shared.capableHostLive("root", 60_000, key), true);
		assert.equal(await shared.restoreFailure(key), undefined, "no host failed to restore it yet");
		const unreachable = serializeError(
			new WorkspaceRestoreError("commits-unavailable", {
				snapshotId: null,
				head: binding.head,
				commits: [binding.head],
			}),
		);
		await shared.recordRestoreBackoff("host-b", key, 60_000, unreachable);
		assert.equal(await shared.capableHostLive("root", 60_000, key), false, "its only capable host backs off from it");
		assert.equal(await shared.capableHostLive("root", 60_000, other), true, "another binding is not held back");
		assert.deepEqual(await shared.restoreFailure(key), unreachable);
		assert.equal(await shared.restoreFailure(other), undefined);
		await report("host-c");
		assert.equal(await shared.capableHostLive("root", 60_000, key), true, "a capable host that does not back off");
		const refused = serializeError(
			new WorkspaceRestoreUnavailableError("no-restore-port", workspaceBindingIdentity(binding), {
				cause: new GitUnavailableError({
					code: "not-installed",
					platform: "linux",
					arch: "x64",
					installDir: "/home/user/.atomic/agent/bin/git",
					installCommand: "sudo apt-get install -y git",
				}),
			}),
		);
		await shared.recordRestoreBackoff("host-c", key, 60_000, refused);
		assert.equal(await shared.capableHostLive("root", 60_000, key), false);
		const last = await shared.restoreFailure(key);
		assert.deepEqual(last, refused, "the failure recorded last");
		const rehydrated = rehydrateError(last);
		assert.ok(rehydrated instanceof WorkspaceRestoreUnavailableError, String(rehydrated));
		assert.equal(rehydrated.reason, "no-restore-port");
		assert.ok(isGitUnavailableError(rehydrated.cause), "its cause comes back as the git error it was");
		assert.deepEqual(
			[rehydrated.cause.code, rehydrated.cause.hint],
			["not-installed", (refused.cause as { readonly hint: string }).hint],
		);
		await shared.recordRestoreBackoff("host-c", key, 0, refused);
		assert.equal(await shared.capableHostLive("root", 60_000, key), true, "a host whose wait ended");
		await shared.recordRestoreBackoff("host-c", key, 60_000, refused);
		await shared.clearRestoreBackoff("host-c", key);
		assert.equal(await shared.capableHostLive("root", 60_000, key), true, "a host that restored it again");
		const kept = rehydrateError(await shared.restoreFailure(key));
		assert.ok(kept instanceof WorkspaceRestoreError, "the host that still backs off keeps its failure, as its class");
		assert.deepEqual(
			[kept.code, kept.fields, kept.hint],
			["commits-unavailable", { snapshotId: null, head: binding.head, commits: [binding.head] }, unreachable.hint],
		);
		await shared.forgetHost("host-b");
		assert.equal(await shared.restoreFailure(key), undefined, "a host that stopped leaves no backoff behind");
		await assert.rejects(
			shared.recordRestoreBackoff("host\u0000", key, 1, unreachable),
			(error: Error) => error instanceof JournalInvalidTextError && error.field === "key",
		);
	} finally {
		await f.close();
	}
});

test("the snapshots recorded with a binding's tree and head are found in every run's checkpoints, oldest first (#4416)", async () => {
	const f = await fixture();
	try {
		const shared = await f.shared();
		const snapshot = (id: string, tree: string, head: string) => ({ id, tree, head, root: "/repo" });
		const checkpoint = (worktreeSnapshots?: readonly ReturnType<typeof snapshot>[]) => ({
			type: RUN_EVENT_TYPES.checkpointRecorded,
			payload: {
				kind: "tool",
				checkpointId: `checkpoint ${binding.tree}`,
				...(worktreeSnapshots === undefined ? {} : { worktreeSnapshots }),
			} as never,
		});
		await f.journal.append(
			f.lease,
			checkpoint([snapshot("first", binding.tree, binding.head), snapshot("other-head", binding.tree, "9")]),
		);
		await f.journal.append(f.lease, checkpoint());
		await f.journal.createRun({ ...header, runId: "producer" });
		const producer = await f.journal.acquire("producer", "producer");
		if (producer.status !== "acquired") assert.fail("no lease");
		await f.journal.append(producer.lease, checkpoint([snapshot("unrelated", "4", binding.head)]));
		await f.journal.append(producer.lease, checkpoint([snapshot("second", binding.tree, binding.head)]));
		assert.deepEqual(
			(await shared.recordedSnapshots(binding)).map((recorded) => recorded.id),
			["first", "second"],
		);
		assert.deepEqual(await shared.recordedSnapshots({ head: binding.head, tree: "5" }), []);
	} finally {
		await f.close();
	}
});

test("work put back unplaced is ready at the generation it had before the claim: the claim is no attempt (#4416)", async () => {
	const f = await fixture();
	try {
		const held = await claimed(f.queue, f.lease, "unplaced", "host-b/worker-1");
		assert.equal(held.generation, 1);
		assert.equal(await f.queue.releaseUnplaced(f.lease, held), true);
		const current = () => f.queue.inspect("root").then((rows) => rows.find((row) => row.id === held.id)!);
		const unplaced = await current();
		assert.deepEqual([unplaced.state, unplaced.generation, unplaced.worker], ["ready", 0, null]);
		assert.equal(
			await f.queue.releaseUnplaced(f.lease, held),
			false,
			"a claim that no longer holds it puts nothing back",
		);
		const again = await f.queue.claim(f.lease, "host-b/worker-2", [definition], 60_000, {
			kind: "work",
			id: held.id,
			generation: 0,
		});
		assert.equal(again?.generation, 1, "the next claim is the child's first attempt again");
		assert.equal(await f.queue.releaseExited(f.lease, again!), true);
		assert.deepEqual(
			[(await current()).state, (await current()).generation],
			["ready", 1],
			"an attempt that ran keeps its generation",
		);
	} finally {
		await f.close();
	}
});
