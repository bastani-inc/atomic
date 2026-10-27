import assert from "node:assert/strict";
import { join } from "node:path";
import type { SqliteExecutor } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { boundaryTransitionError } from "../../packages/workflows/src/durable/boundary-lifecycle.js";
import { validateCheckpointInvocationFingerprint } from "../../packages/workflows/src/durable/boundary-topology.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { PoolCheckpointIndex } from "../../packages/workflows/src/durable/journal/pool-checkpoint-index.js";
import {
	type PoolCheckpointMutation,
	poolTopologyDivergence,
	validatePoolMutation,
} from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import {
	directChildTopologyError,
	sameRun,
	sameStrings,
} from "../../packages/workflows/src/durable/stage-topology-validation.js";
import {
	DURABLE_TOOL_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
	type DurableToolCheckpoint,
} from "../../packages/workflows/src/durable/types.js";
import { parseWorkflowChildResult } from "../../packages/workflows/src/durable/workflow-child-result.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

type Tables = { runs: string; events: string; leases: string };

/** `validatePoolMutation` as it was before the checkpoint index: it read and parsed every recorded checkpoint. */
async function originalValidatePoolMutation(
	tx: SqliteExecutor,
	journal: Tables,
	root: string,
	work: PoolWork,
	mutation: PoolCheckpointMutation,
): Promise<void> {
	if (!["checkpoint", "session-create", "session-replace"].includes(mutation.kind))
		throw new Error("Invalid pool mutation");
	const checkpoint = mutation.checkpoint;
	const prefix = `${work.scope}:`;
	const key =
		checkpoint.kind === "tool"
			? checkpoint.argsHash
			: checkpoint.kind === "ui"
				? checkpoint.promptHash
				: checkpoint.kind === "stage"
					? checkpoint.replayKey
					: "";
	if (checkpoint.workflowId !== root || !checkpoint.checkpointId.startsWith(prefix) || !key.startsWith(prefix))
		throw new Error("Pool checkpoint scope mismatch");
	validateCheckpointInvocationFingerprint(checkpoint);
	if (checkpoint.kind === "stage" && checkpoint.sessionFile !== undefined)
		throw new Error("Pool sessions require database identity");
	if (mutation.kind !== "checkpoint" && checkpoint.kind !== "stage") throw new Error("Invalid pool session mutation");
	if (mutation.kind === "checkpoint" && checkpoint.kind === "stage" && checkpoint.sessionId) {
		const owner = await tx.get(
			`SELECT work, replay_key FROM ${journal.runs}_pool_session_owners WHERE session = ?`,
			checkpoint.sessionId,
		);
		if (owner?.work !== work.id || owner.replay_key !== checkpoint.replayKey)
			throw new Error("Pool session scope mismatch");
	}
	if (checkpoint.kind === "ui") return;
	const rows = await tx.all(
		`SELECT payload FROM ${journal.events} WHERE run_id = ? AND type = ?`,
		root,
		RUN_EVENT_TYPES.checkpointRecorded,
	);
	const records = rows.map((row) => JSON.parse(String(row.payload)) as DurableCheckpoint);
	const stages = records.filter((entry): entry is DurableStageCheckpoint => entry.kind === "stage");
	const topology = checkpoint.topology;
	const run = topology?.run;
	if (!topology || !run || run.rootRunId !== root || run.runId === root)
		throw new Error("Pool topology scope mismatch");
	const owner = stages.find(
		(entry) => entry.topology?.boundary?.event === "start" && entry.topology.boundary.child.runId === run.runId,
	)?.topology?.boundary;
	if (
		!owner ||
		!sameRun(run, owner.child) ||
		!key.startsWith(`${owner.replayScope}:`) ||
		!checkpoint.checkpointId.startsWith(`${owner.replayScope}:`) ||
		!(owner.replayScope === work.scope || owner.replayScope.startsWith(prefix))
	)
		throw new Error("Pool topology scope mismatch");
	if (
		mutation.kind !== "checkpoint" &&
		"header" in mutation &&
		mutation.header.workflow &&
		(mutation.header.workflow.runId !== run.runId ||
			mutation.header.workflow.stageId !== ("stageId" in topology ? topology.stageId : undefined))
	)
		throw new Error("Pool session scope mismatch");
	if (checkpoint.kind === "tool") {
		const tool = checkpoint.topology!;
		const peers = records.filter(
			(entry): entry is Exclude<DurableCheckpoint, { kind: "ui" }> =>
				entry.kind !== "ui" && entry.topology?.run?.runId === run.runId,
		);
		const ids = new Set(
			peers.map((entry) => (entry.kind === "tool" ? entry.topology!.nodeId : entry.topology!.stageId)),
		);
		if (
			tool.version !== DURABLE_TOOL_TOPOLOGY_VERSION ||
			!tool.nodeId ||
			tool.parentIds.some((id) => id === tool.nodeId || !ids.has(id)) ||
			peers.some((entry) =>
				entry.kind === "tool"
					? entry.argsHash === checkpoint.argsHash
						? entry.topology!.nodeId !== tool.nodeId || !sameStrings(entry.topology!.parentIds, tool.parentIds)
						: entry.topology!.nodeId === tool.nodeId
					: entry.topology!.stageId === tool.nodeId,
			)
		)
			throw new Error("Pool tool topology scope mismatch");
		return;
	}
	const next = [...stages.filter((entry) => entry.checkpointId !== checkpoint.checkpointId), checkpoint];
	const tools = new Set(
		records.flatMap((entry) =>
			entry.kind === "tool" && entry.topology?.run?.runId === run.runId ? [entry.topology.nodeId] : [],
		),
	);
	const stageError = directChildTopologyError(next, owner.replayScope, run, tools);
	if (stageError) throw new Error(poolTopologyDivergence(run.runName, stageError));
	const boundary = checkpoint.topology?.boundary;
	if (!boundary) {
		if (parseWorkflowChildResult(checkpoint.output)) throw new Error("Pool boundary output without ownership");
		return;
	}
	const start = next.find(
		(entry) => entry.replayKey === checkpoint.replayKey && entry.topology?.boundary?.event === "start",
	);
	const boundaryError = start ? boundaryTransitionError(start, next, false) : "missing start";
	if (
		!boundary.replayScope.startsWith(`${owner.replayScope}:`) ||
		boundary.child.runId === root ||
		boundary.child.runId === work.childRunId ||
		boundaryError
	)
		throw new Error(`Pool boundary scope: ${boundaryError ?? "invalid child"}`);
}

type Outcome = "accepted" | string;
const outcome = (promise: Promise<void>): Promise<Outcome> =>
	promise.then(
		() => "accepted",
		(error: Error) => `${error.constructor.name}: ${error.message}`,
	);

/** Deterministic PRNG so a failing seed reproduces. */
function random(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		chance: (p: number) => next() < p,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
		subset: <T>(items: readonly T[]): T[] => items.filter(() => next() < 0.04),
	};
}

async function journalFixture() {
	const directory = makeTempDirectory("pool-checkpoint-index-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	await openSqlPoolQueue(journal);
	const tables = sqlPoolStorage(journal)!.tables;
	let clock = 1;
	/** Append one event the way the journal does: the next sequence, keyed by checkpoint identity. */
	const record = async (tx: SqliteExecutor, payload: object, type: string = RUN_EVENT_TYPES.checkpointRecorded) => {
		const checkpoint = payload as DurableCheckpoint;
		const key =
			type === RUN_EVENT_TYPES.checkpointRecorded
				? JSON.stringify([type, checkpoint.kind, checkpoint.checkpointId])
				: null;
		const seq =
			Number(
				(await tx.get(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${tables.events} WHERE run_id = 'root'`))!.seq,
			) + 1;
		await tx.run(
			`INSERT OR IGNORE INTO ${tables.events} VALUES ('root', ?, 1, ?, ?, ?, ?)`,
			seq,
			key,
			type,
			JSON.stringify(payload),
			clock++,
		);
	};
	return {
		database,
		tables,
		record,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

type Fixture = Awaited<ReturnType<typeof journalFixture>>;

function child(index: number) {
	const { work, boundary } = poolWorkFixture(`b${index}`, `child-${index}`, `workflow:b${index}:0`);
	const poolWork: PoolWork = {
		...work,
		id: `work-${index}`,
		state: "leased",
		generation: 1,
		worker: "worker",
		epoch: 1,
		expiresAt: 0,
		renewedAt: 0,
	};
	return { work: poolWork, boundary, run: { ...boundary.topology!.boundary!.child } };
}

/** Random pool histories: colliding ids, stage groups, prompt occurrences, nested boundaries, and malformed records. */
function generator(seed: number, children: number) {
	const r = random(seed);
	const ids = ["s0", "s1", "s2", "t0", "t1", "n0", "é", "\uffff", "😀"];
	const suffixes = ["a", "b", "c", "é", "\uffff", "😀"];
	const runOf = (index: number) => {
		const run = child(index).run;
		if (r.chance(0.04)) return { ...run, runName: "renamed" };
		if (r.chance(0.04)) return child(r.int(children)).run;
		return run;
	};
	const checkpoint = (index: number): DurableCheckpoint => {
		const { work } = child(index);
		const scope = r.chance(0.02) ? `workflow:b${r.int(children)}:0` : work.scope;
		const run = runOf(index);
		const kind = r.pick(["tool", "tool", "stage", "stage", "boundary", "boundary", "ui"] as const);
		if (kind === "ui")
			return {
				kind: "ui",
				workflowId: "root",
				checkpointId: `${scope}:ui:${r.int(3)}`,
				promptKind: "input",
				message: "?",
				promptHash: `${scope}:prompt`,
				response: "yes",
				completedAt: 1,
			};
		if (kind === "tool") {
			const tool: DurableToolCheckpoint = {
				kind: "tool",
				workflowId: "root",
				checkpointId: `${scope}:tool:${r.pick(ids)}`,
				name: "tool",
				argsHash: `${scope}:args:${r.int(4)}`,
				output: r.int(3),
				completedAt: 1,
				topology: {
					version: r.chance(0.97) ? 1 : (2 as 1),
					nodeId: r.chance(0.97) ? r.pick(ids) : "",
					parentIds: r.subset(ids),
					ordinal: 0,
					order: 0,
					run,
				},
			};
			return tool;
		}
		if (kind === "stage") {
			const replayKey = `${scope}:${r.pick(suffixes)}`;
			const occurrenceKey = r.chance(0.2) ? `occurrence-${r.int(2)}` : undefined;
			return {
				kind: "stage",
				workflowId: "root",
				checkpointId: `${replayKey}:${r.int(2)}`,
				name: r.chance(0.95) ? "stage" : "other",
				replayKey,
				completedAt: r.int(3),
				...(r.chance(0.2)
					? {
							output: r.chance(0.5)
								? "text"
								: { workflow: "w", runId: "x", status: "completed", exited: false, outputs: {} },
						}
					: {}),
				...(r.chance(0.03)
					? {}
					: {
							topology: {
								version: 1 as const,
								stageId: r.pick(ids),
								parentIds: r.subset(ids),
								...(r.chance(0.95) ? { sourceOrder: r.int(30) } : {}),
								...(occurrenceKey ? { occurrenceKey } : {}),
								status: "completed" as const,
								...(r.chance(0.97) ? { run } : {}),
							},
						}),
			};
		}
		const nested = `${scope}:nested:${r.int(3)}`;
		const event = r.pick(["start", "start", "terminal"] as const);
		const status = event === "start" ? "running" : r.pick(["completed", "failed", "skipped"] as const);
		const stageId = r.pick(ids);
		const grandchild = r.chance(0.05) ? r.pick(["root", work.childRunId]) : `g-${index}-${r.int(3)}`;
		return {
			kind: "stage",
			workflowId: "root",
			checkpointId: `${nested}:boundary-${event}${r.chance(0.1) ? "-again" : ""}`,
			name: "nested",
			replayKey: r.chance(0.95) ? nested : `${scope}:${r.pick(suffixes)}`,
			completedAt: r.int(3),
			...(status === "completed" && r.chance(0.9)
				? { output: { workflow: "w", runId: grandchild, status: "completed", exited: false, outputs: {} } }
				: {}),
			topology: {
				version: 1,
				stageId,
				parentIds: r.chance(0.9) ? [] : r.subset(ids),
				sourceOrder: r.int(30),
				status,
				run,
				boundary: {
					version: 1,
					event,
					status,
					replayScope: r.chance(0.95) ? nested : scope,
					alias: "nested",
					workflow: "w",
					invocationFingerprint: "f",
					child: {
						runId: grandchild,
						runName: "g",
						parentRunId: run.runId,
						parentStageId: stageId,
						rootRunId: "root",
					},
				},
			} as DurableStageCheckpoint["topology"],
		} as DurableStageCheckpoint;
	};
	const mutation = (index: number): PoolCheckpointMutation => {
		const recorded = checkpoint(index);
		if (recorded.kind === "stage" && r.chance(0.15)) {
			const stageId = recorded.topology?.stageId;
			return {
				kind: "session-create",
				checkpoint: recorded,
				header: {
					id: "session",
					version: 4,
					createdAt: "2026-01-01T00:00:00Z",
					cwd: "/",
					...(r.chance(0.7)
						? {
								workflow: {
									runId: r.chance(0.9) ? (recorded.topology?.run?.runId ?? "") : "other",
									stageId: r.chance(0.9) ? (stageId ?? "") : "other",
								},
							}
						: {}),
				},
				entries: [],
			} as PoolCheckpointMutation;
		}
		if (r.chance(0.01)) return { kind: "bogus", checkpoint: recorded } as unknown as PoolCheckpointMutation;
		return { kind: "checkpoint", checkpoint: recorded };
	};
	/** The root's boundary start for a child, sometimes recorded twice under different keys to test the lookup order. */
	const start = (index: number): DurableStageCheckpoint => {
		const { boundary } = child(index);
		return r.chance(0.1)
			? {
					...boundary,
					checkpointId: `boundary-start:${r.pick(suffixes)}:${index}`,
					topology: {
						...boundary.topology!,
						boundary: { ...boundary.topology!.boundary!, replayScope: r.pick([boundary.replayKey, "elsewhere"]) },
					},
				}
			: boundary;
	};
	return { r, checkpoint, mutation, start };
}

async function seedRoot(f: Fixture, g: ReturnType<typeof generator>, children: number): Promise<void> {
	await f.database.transaction(async (tx) => {
		for (let index = 0; index < children; index++) if (g.r.chance(0.9)) await f.record(tx, g.start(index));
	});
}

test("the indexed validator accepts and rejects exactly what the full-history validator does", async () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		const f = await journalFixture();
		try {
			const children = 6;
			const g = generator(seed, children);
			let index = new PoolCheckpointIndex();
			await seedRoot(f, g, children);
			const decisions = new Map<string, number>();
			for (let step = 0; step < 400; step++) {
				const target = g.r.int(children);
				const { work } = child(target);
				const batch = Array.from({ length: g.r.chance(0.2) ? 3 : 1 }, () => g.mutation(target));
				const expected = await Promise.all(
					batch.map((mutation) =>
						outcome(
							f.database.transaction((tx) => originalValidatePoolMutation(tx, f.tables, "root", work, mutation)),
						),
					),
				);
				// Several reads in one group commit, as concurrent pool commits are.
				const actual = await Promise.all(
					batch.map(async (mutation) => {
						const read = index.begin("root");
						const result = await outcome(
							f.database.transaction((tx) => validatePoolMutation(tx, f.tables, "root", work, mutation, read)),
						);
						read.commit();
						return result;
					}),
				);
				assert.deepEqual(actual, expected, `seed ${seed} step ${step}`);
				for (const result of expected) decisions.set(result, (decisions.get(result) ?? 0) + 1);
				await f.database.transaction(async (tx) => {
					for (const [position, mutation] of batch.entries())
						if (g.r.chance(expected[position] === "accepted" ? 0.7 : 0.1))
							await f.record(tx, mutation.checkpoint);
					if (g.r.chance(0.3)) await f.record(tx, g.checkpoint(g.r.int(children)));
					if (g.r.chance(0.05)) await f.record(tx, g.start(g.r.int(children)));
					for (let noise = g.r.int(4); noise > 0; noise--)
						await f.record(tx, { delivered: step }, RUN_EVENT_TYPES.messageDelivered);
				});
				if (g.r.chance(0.05)) {
					// A transaction whose read is never committed: its rows must not reach the index.
					const read = index.begin("root");
					await outcome(
						f.database.transaction(async (tx) => {
							await f.record(tx, g.start(g.r.int(children)));
							await f.record(tx, g.checkpoint(target));
							await validatePoolMutation(tx, f.tables, "root", work, g.mutation(target), read);
							throw new Error("rolled back");
						}),
					);
				}
				if (g.r.chance(0.02)) index = new PoolCheckpointIndex();
				if (g.r.chance(0.01)) {
					// Delete the root's history and record it again: the index must notice and rebuild.
					await f.database.run(`DELETE FROM ${f.tables.events} WHERE run_id = 'root'`);
					await seedRoot(f, g, children);
				}
			}
			assert.ok((decisions.get("accepted") ?? 0) > 50, JSON.stringify([...decisions]));
			assert.ok(decisions.size > 8, JSON.stringify([...decisions]));
		} finally {
			await f.close();
		}
	}
});

function toolMutation(index: number, nodeId: string): PoolCheckpointMutation {
	const { work, run } = child(index);
	return {
		kind: "checkpoint",
		checkpoint: {
			kind: "tool",
			workflowId: "root",
			checkpointId: `${work.scope}:tool:${nodeId}`,
			name: "tool",
			argsHash: `${work.scope}:args:${nodeId}`,
			output: null,
			completedAt: 1,
			topology: { version: 1, nodeId, parentIds: [], ordinal: 0, order: 0, run },
		},
	};
}

/** Validate with both validators; the index read is committed only when `commit` holds, as the pool queue does. */
async function compare(f: Fixture, index: PoolCheckpointIndex, target: number, mutation: PoolCheckpointMutation) {
	const { work } = child(target);
	const expected = await outcome(
		f.database.transaction((tx) => originalValidatePoolMutation(tx, f.tables, "root", work, mutation)),
	);
	const read = index.begin("root");
	const actual = await outcome(
		f.database.transaction((tx) => validatePoolMutation(tx, f.tables, "root", work, mutation, read)),
	);
	read.commit();
	assert.equal(actual, expected);
	return actual;
}

test("a rolled-back transaction's checkpoints never reach the index", async () => {
	const f = await journalFixture();
	try {
		const index = new PoolCheckpointIndex();
		const mutation = toolMutation(0, "t");
		assert.equal(await compare(f, index, 0, mutation), "Error: Pool topology scope mismatch");
		const read = index.begin("root");
		await assert.rejects(
			f.database.transaction(async (tx) => {
				await f.record(tx, child(0).boundary);
				await validatePoolMutation(tx, f.tables, "root", child(0).work, mutation, read);
				throw new Error("rolled back after validation");
			}),
			/rolled back after validation/,
		);
		assert.equal(await compare(f, index, 0, mutation), "Error: Pool topology scope mismatch");
		// A committed event now takes the sequence the rolled-back checkpoint had.
		await f.database.transaction((tx) => f.record(tx, { delivered: 1 }, RUN_EVENT_TYPES.messageDelivered));
		for (let attempt = 0; attempt < 2; attempt++)
			assert.equal(await compare(f, index, 0, mutation), "Error: Pool topology scope mismatch");
		await f.database.transaction((tx) => f.record(tx, child(0).boundary));
		assert.equal(await compare(f, index, 0, mutation), "accepted");
	} finally {
		await f.close();
	}
});

test("the index sees checkpoints other connections append, and a restarted index rebuilds from the journal", async () => {
	const f = await journalFixture();
	const other = await openNodeSqliteDatabase(f.database.descriptor.location);
	try {
		let index = new PoolCheckpointIndex();
		await f.database.transaction((tx) => f.record(tx, child(0).boundary));
		assert.equal(await compare(f, index, 0, toolMutation(0, "t")), "accepted");
		// The root host records the tool and another child's boundary through its own connection.
		await other.transaction(async (tx) => {
			await f.record(tx, toolMutation(0, "t").checkpoint);
			await f.record(tx, child(1).boundary);
		});
		assert.equal(await compare(f, index, 0, toolMutation(0, "t")), "accepted");
		assert.equal(await compare(f, index, 1, toolMutation(1, "t")), "accepted");
		// A clashing node id is rejected once the first tool is indexed.
		const clash = toolMutation(0, "t");
		const clashing = { ...clash, checkpoint: { ...clash.checkpoint, argsHash: `${child(0).work.scope}:args:other` } };
		assert.equal(
			await compare(f, index, 0, clashing as PoolCheckpointMutation),
			"Error: Pool tool topology scope mismatch",
		);
		index = new PoolCheckpointIndex();
		assert.equal(
			await compare(f, index, 0, clashing as PoolCheckpointMutation),
			"Error: Pool tool topology scope mismatch",
		);
		assert.equal(await compare(f, index, 1, toolMutation(1, "t")), "accepted");
	} finally {
		await other.close();
		await f.close();
	}
});

test("the index rebuilds when the root's history is deleted and recorded again past its watermark", async () => {
	const f = await journalFixture();
	try {
		const index = new PoolCheckpointIndex();
		await f.database.transaction(async (tx) => {
			await f.record(tx, child(0).boundary);
			for (let seq = 0; seq < 9; seq++) await f.record(tx, { delivered: seq }, RUN_EVENT_TYPES.messageDelivered);
		});
		assert.equal(await compare(f, index, 0, toolMutation(0, "t")), "accepted");
		await f.database.run(`DELETE FROM ${f.tables.events} WHERE run_id = 'root'`);
		await f.database.transaction(async (tx) => {
			for (let seq = 0; seq < 12; seq++) await f.record(tx, { delivered: seq }, RUN_EVENT_TYPES.messageDelivered);
		});
		assert.equal(await compare(f, index, 0, toolMutation(0, "t")), "Error: Pool topology scope mismatch");
	} finally {
		await f.close();
	}
});
