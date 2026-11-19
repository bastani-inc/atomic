import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { isLiveRunningWorkflow } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { latestStageSessionCheckpoints } from "../../packages/workflows/src/durable/stage-primitive.js";
import { CheckpointShipping } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { poolWorkerCommit } from "../../packages/workflows/src/workers/pool-commit.js";
import { ShipShard } from "../../packages/workflows/src/workers/ship-shard.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`folding local checkpoint receipts on ${name}`, () => {
		test.each([
			{ label: "folding the first shipment keeps the newer acknowledged root live", retryAt: undefined },
			...[41, 42, 43].map((retryAt) => ({
				label: `a session retried at ${retryAt} keeps its journal time`,
				retryAt,
			})),
		])("$label (#5480)", async ({ retryAt }) => {
			const scope = await backend.openScope();
			const close: (() => Promise<void>)[] = [() => scope.close()];
			try {
				const journal = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				close.push(() => journal.close());
				const writer = await JournalDurableBackend.open(journal, { ownsJournal: false });
				close.push(() => writer.close());
				await writer.commitWorkflowRegistration({
					workflowId: "root",
					name: "root",
					inputs: {},
					status: "running",
					createdAt: 1,
				});
				const ownership = await journal.acquire("root", writer.holderId);
				assert.ok(ownership.status === "acquired");
				const { lease } = ownership;
				const queue = await openSqlPoolQueue(journal);
				await queue.initialize(lease, 60_000);
				const { work, boundary } = poolWorkFixture();
				await queue.enqueue(lease, work, boundary);
				const attempt = await queue.claim(lease, "worker", [work], 60_000);
				assert.ok(attempt);
				const replayKey = `${work.scope}:task`;
				const session = (id: string, completedAt: number) => ({
					kind: "stage" as const,
					workflowId: "root",
					checkpointId: `${work.scope}:${id}`,
					name: "task",
					replayKey,
					sessionId: `s-${id}`,
					completedAt,
					topology: {
						version: 1 as const,
						stageId: "task",
						parentIds: [],
						sourceOrder: 0,
						run: { ...boundary.topology!.boundary!.child },
					},
				});
				const old = session("old", 42),
					latest = session("new", retryAt === undefined ? old.completedAt + 180_000 : 42);
				for (const checkpoint of [old, latest])
					await queue.commit(lease, attempt, `create-${checkpoint.sessionId}`, {
						kind: "session-create",
						checkpoint: { ...checkpoint, checkpointId: `${checkpoint.checkpointId}:create`, completedAt: 0 },
						header: {
							id: checkpoint.sessionId,
							version: 4,
							createdAt: "2026-01-01T00:00:00Z",
							cwd: "/project",
						},
						entries: [],
					});
				const reader = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: ["root"] });
				close.push(() => reader.close());
				const shipping = new CheckpointShipping(await ShipShard.open(":memory:", "root"), {
					intervalMs: 60_000,
					maxBatch: 64,
					maxLagMs: 600_000,
					host: "host",
					deliver: (held, batch) => queue.shipBatch(lease, held, batch),
				});
				close.push(() => shipping.close());
				await shipping.hold(attempt, 60_000);
				let lose = retryAt !== undefined;
				const commit = poolWorkerCommit({
					send: async (mutation) => {
						const receipt = await shipping.commit(attempt, mutation, async () =>
							assert.fail("expected local receipt"),
						);
						assert.equal(receipt.local, true);
						if (lose) {
							lose = false;
							throw new Error("lost receipt");
						}
						return receipt;
					},
					catchUp: () => reader.catchUpWorkflow("root"),
					noteLocal: (checkpoint) => reader.noteRecordedCheckpoint(checkpoint),
				});
				const views = () => {
					const direct = reader.getStageSession("root", replayKey)?.sessionId;
					assert.equal(direct, latestStageSessionCheckpoints(reader, "root").get(replayKey)?.sessionId);
					return direct;
				};
				const retry = { kind: "checkpoint" as const, checkpoint: old };
				if (retryAt === undefined) await commit(retry);
				else await assert.rejects(commit(retry), /lost receipt/);
				await shipping.flush(attempt);
				await commit({ kind: "checkpoint", checkpoint: latest });
				assert.equal(views(), latest.sessionId);
				if (retryAt !== undefined) {
					await commit({ ...retry, checkpoint: { ...old, completedAt: retryAt } });
					assert.equal(views(), retryAt >= latest.completedAt ? old.sessionId : latest.sessionId);
					await reader.retainCheckpoints("root", { ids: [], prefixes: [`${work.scope}:`] });
					views();
				} else assert.equal(reader.getWorkflow("root")?.updatedAt, latest.completedAt);
				await reader.catchUpWorkflow("root");
				assert.equal(views(), latest.sessionId);
				if (retryAt === undefined) {
					const root = reader.getWorkflow("root")!;
					assert.deepEqual(
						[
							root.updatedAt,
							reader.toMetadata("root")?.updatedAt,
							isLiveRunningWorkflow(root, latest.completedAt),
						],
						[latest.completedAt, latest.completedAt, true],
					);
				}
				await shipping.flush(attempt);
				await reader.catchUpWorkflow("root");
				const fresh = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: ["root"] });
				close.push(() => fresh.close());
				assert.equal(views(), latest.sessionId);
				assert.deepEqual(reader.getStageSession("root", replayKey), fresh.getStageSession("root", replayKey));
				assert.deepEqual(reader.getWorkflow("root"), fresh.getWorkflow("root"));
			} finally {
				for (const end of close.reverse()) await end();
			}
		});
	});
}
