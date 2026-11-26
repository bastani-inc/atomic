import assert from "node:assert/strict";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import type { IntercomBrokerStateStore } from "../../packages/intercom/broker/multinode-state-store.js";

const from = { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

/**
 * A claimed row whose claimant is missing, as no write of this build leaves one, but a hand edit or a partial write
 * could: no broker holds the recipient through it, so a claim never answers `held` for it. It stays in flight until
 * its claim goes stale, since nothing renews it, and the next claim then takes it over, as before the claim was one
 * statement (#6560). `table` is the outbox table, with its prefix.
 */
export async function checkClaimantlessRow(
	state: IntercomBrokerStateStore,
	database: SqliteDatabase,
	table: string,
): Promise<void> {
	const queued = await state.outbox.enqueue({
		targetIdentity: "target-n",
		originBrokerId: "broker-a",
		digest: "m-1",
		frame: { type: "message", from, message: { id: "m-1", timestamp: 1, content: { text: "m-1" } } },
	});
	assert.equal(queued.status, "inserted");
	const first = await state.outbox.claim({ claimantId: "broker-a", targetIdentity: "target-n", staleAfterMs: 30_000 });
	assert.equal(first.status, "claimed");
	await database.run(`UPDATE ${table} SET claimant_id = NULL WHERE message_id = ?`, "m-1");
	assert.deepEqual(
		await state.outbox.claim({ claimantId: "broker-b", targetIdentity: "target-n", staleAfterMs: 30_000 }),
		{ status: "claimed", rows: [] },
	);
	await new Promise((resolve) => setTimeout(resolve, 100));
	const taken = await state.outbox.claim({ claimantId: "broker-b", targetIdentity: "target-n", staleAfterMs: 50 });
	assert.deepEqual(
		taken.status === "claimed"
			? taken.rows.map(({ row, claim }) => [row.messageId, claim.claimantId, claim.attempt])
			: taken,
		[["m-1", "broker-b", 2]],
	);
}
