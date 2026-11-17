import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import {
	SHARED_LEASES_TABLE,
	TWO_BROKER_STORAGE_PREFIX,
	type TwoBrokerClient,
	TwoBrokerHarness,
} from "../helpers/intercom-two-broker-harness.js";

const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const ARRIVAL_WAIT = { timeout: 15_000, interval: 25 };

const KNOWN_SESSIONS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_known_sessions`;
const OUTBOX_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_outbox`;
const RESERVATIONS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_restoring_reservations`;
const WAKE_CLAIMS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_restoring_wake_claims`;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

type PresenceSnapshot = {
	readonly key: string;
	readonly holder_id: string;
	readonly fencing_token: number;
	readonly subject_json: string;
};

async function reserveWithoutOwnerMirrorAliasesAndSeedSharedTargets(
	shared: SqliteDatabase,
	owner: TwoBrokerClient,
	childName: string,
	subgroup: string,
	aliases: readonly string[],
): Promise<string> {
	await owner.client.reserveReleasedChildren([{ childName, group: subgroup, wake: true }]);
	const reservationKey = releasedReservationKey(childName);
	await vi.waitFor(async () => {
		const row = await shared.get<{ reservation_key: string }>(
			`SELECT reservation_key FROM ${RESERVATIONS_TABLE} WHERE reservation_key = ? AND end_json IS NULL`,
			reservationKey,
		);
		assert.equal(row?.reservation_key, reservationKey);
	}, ARRIVAL_WAIT);
	await shared.run(
		`UPDATE ${RESERVATIONS_TABLE} SET targets_json = ? WHERE reservation_key = ?`,
		JSON.stringify([childName.toLowerCase(), ...aliases]),
		reservationKey,
	);
	return reservationKey;
}

async function restorePresenceUntilNextOutboxInsert(shared: SqliteDatabase, lease: PresenceSnapshot): Promise<void> {
	await shared.exec(
		`CREATE TRIGGER release_presence_on_outbox_insert AFTER INSERT ON ${OUTBOX_TABLE}
		 WHEN NEW.target_identity = '${lease.key}'
		 BEGIN
		   UPDATE ${SHARED_LEASES_TABLE}
		   SET holder_id = NULL, fencing_token = NULL, subject_json = NULL, renewed_at = NULL
		   WHERE kind = 'presence' AND key = NEW.target_identity;
		 END`,
	);
	await shared.run(
		`UPDATE ${SHARED_LEASES_TABLE}
		 SET holder_id = ?, fencing_token = ?, subject_json = ?, renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
		 WHERE kind = 'presence' AND key = ?`,
		lease.holder_id,
		lease.fencing_token,
		lease.subject_json,
		lease.key,
	);
}

test(
	"with multi-node routing, a policy sibling's send to a released subagent in a home subgroup wakes it when queued after departure (#5352)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const shared = await harness.openSharedStorage("a");
		const home = unique("home_%_🚀-wake");
		const subgroup = `${home}/x`;
		const owner = await harness.connect("b", unique("owner-b"), {
			group: home,
			reachable: [],
			supervisorOwnerToken: randomUUID(),
		});
		const sibling = await harness.connect("a", unique("sibling-a"), {
			group: home,
			reachable: [],
		});

		const childName = `subagent-worker-${unique("released-sub")}-1`;
		const returnAddress = randomUUID();
		const sessionId = randomUUID();
		const initialAuth = await owner.client.authorizeSupervisorChild(childName);
		const child = await harness.connect("b", childName, {
			group: subgroup,
			reachable: [],
			returnAddress,
			preferredSessionId: sessionId,
			supervisor: initialAuth,
		});
		assert.equal(child.sessionId, sessionId);

		const lease = await vi.waitFor(async () => {
			const row = await shared.get<PresenceSnapshot>(
				`SELECT key, holder_id, fencing_token, subject_json
				 FROM ${SHARED_LEASES_TABLE}
				 WHERE kind = 'presence' AND holder_id IS NOT NULL AND subject_json LIKE ?`,
				`%${sessionId}%`,
			);
			assert.ok(row);
			return row;
		}, ARRIVAL_WAIT);

		await harness.disconnect(child);
		await vi.waitFor(async () => {
			const row = await shared.get<{ holder_id: string | null }>(
				`SELECT holder_id FROM ${SHARED_LEASES_TABLE} WHERE kind = 'presence' AND key = ?`,
				lease.key,
			);
			assert.equal(row?.holder_id, null);
			const known = await shared.get<{ target_identity: string }>(
				`SELECT target_identity FROM ${KNOWN_SESSIONS_TABLE} WHERE target_identity = ?`,
				lease.key,
			);
			assert.equal(known?.target_identity, lease.key);
		}, ARRIVAL_WAIT);

		const wakes: Array<{ childName: string }> = [];
		owner.client.on("restoring_recipient_wake", (notice: { childName: string }) => wakes.push(notice));
		const reservationKey = await reserveWithoutOwnerMirrorAliasesAndSeedSharedTargets(
			shared,
			owner,
			childName,
			subgroup,
			[returnAddress, sessionId],
		);
		await restorePresenceUntilNextOutboxInsert(shared, lease);

		const messageId = randomUUID();
		const text = "queued after subgroup child departure";
		const sent = await sibling.client.send(childName, { messageId, text });
		assert.equal(sent.delivered, false, JSON.stringify(sent));
		assert.equal(sent.queued, true, JSON.stringify(sent));
		assert.equal(sent.target, "offline session");

		await vi.waitFor(async () => {
			assert.deepEqual(wakes, [{ childName }]);
			const claim = await shared.get<{ message_id: string }>(
				`SELECT message_id FROM ${WAKE_CLAIMS_TABLE} WHERE reservation_key = ? AND message_id = ?`,
				reservationKey,
				messageId,
			);
			assert.equal(claim?.message_id, messageId);
		}, ARRIVAL_WAIT);

		const sharedWakeAuth = await owner.client.authorizeSupervisorChild(childName);
		const woken = await harness.connect("b", childName, {
			group: subgroup,
			reachable: [],
			returnAddress,
			preferredSessionId: sessionId,
			supervisor: sharedWakeAuth,
		});
		await vi.waitFor(async () => {
			assert.deepEqual(
				woken.received.map((frame) => frame.message.content.text),
				[text],
			);
			const outbox = await shared.get<{ state: string }>(
				`SELECT state FROM ${OUTBOX_TABLE} WHERE message_id = ?`,
				messageId,
			);
			assert.equal(outbox?.state, "delivered");
		}, ARRIVAL_WAIT);
		assert.equal(wakes.length, 1);
	},
	REAL_BROKERS_HOOK_TIMEOUT_MS,
);
