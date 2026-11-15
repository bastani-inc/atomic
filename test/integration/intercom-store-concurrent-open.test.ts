import assert from "node:assert/strict";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openDatabaseWakeUpBus } from "../../packages/intercom/broker/database-wake-up-bus.js";
import type { IntercomBrokerStateOptions } from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openSqlHeldSendStore } from "../../packages/intercom/broker/sql-held-send-store.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { openSqlPendingAskStore } from "../../packages/intercom/broker/sql-pending-ask-store.js";
import { openSqlReleasedAskStore } from "../../packages/intercom/broker/sql-released-ask-store.js";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { openSqlSentMessageAuthority } from "../../packages/intercom/broker/sql-sent-message-authority.js";
import { storageBackends } from "../helpers/storage-backends.js";

/**
 * Brokers started together on a new database each open every multi-node routing store on the same fresh prefix. Each
 * opener uses a connection of its own, as a broker on another host does, and every one of them must succeed.
 */

/** Concurrent openers per store: enough that unserialized `CREATE … IF NOT EXISTS` statements collide on Postgres. */
const OPENERS = 8;
/** Opening a store on a server backend `OPENERS` times, each waiting its turn for the schema lock. */
const CONCURRENT_OPEN_TIMEOUT_MS = 60_000;

const stores: Readonly<Record<string, (options: IntercomBrokerStateOptions) => Promise<object>>> = {
	"broker lease store": openSqlBrokerLeaseStore,
	"outbox store": openSqlOutboxStore,
	"restoring reservation store": openSqlRestoringReservationStore,
	"held send store": openSqlHeldSendStore,
	"known session store": openSqlKnownSessionStore,
	"pending ask store": openSqlPendingAskStore,
	"released ask store": openSqlReleasedAskStore,
	"sent message authority": openSqlSentMessageAuthority,
	"wake-up bus": async ({ database, prefix }) => {
		const bus = await openDatabaseWakeUpBus({ openDatabase: async () => database, prefix });
		await bus.close();
		return bus;
	},
};

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? test : test.skip;
	for (const [name, open] of Object.entries(stores)) {
		run(
			`${OPENERS} brokers opening the ${name} on a new ${backend.name} prefix at once all succeed (#5054)`,
			async () => {
				const scope = await backend.openScope();
				try {
					const databases: SqliteDatabase[] = await Promise.all(
						Array.from({ length: OPENERS }, () => scope.connect()),
					);
					const results = await Promise.allSettled(
						databases.map((database) => open({ database, prefix: scope.prefix })),
					);
					const failures = results.flatMap((result) =>
						result.status === "rejected" ? [String(result.reason?.cause ?? result.reason)] : [],
					);
					assert.deepEqual(failures, []);
				} finally {
					await scope.close();
				}
			},
			CONCURRENT_OPEN_TIMEOUT_MS,
		);
	}
}

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? test : test.skip;
	run(
		`${OPENERS} brokers opening multi-node routing state on a new ${backend.name} prefix at once all succeed (#5054)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const results = await Promise.allSettled(
					Array.from({ length: OPENERS }, () =>
						openIntercomBrokerState({ openDatabase: () => scope.connect(), prefix: scope.prefix }),
					),
				);
				const failures = results.flatMap((result) =>
					result.status === "rejected" ? [String(result.reason?.cause ?? result.reason)] : [],
				);
				for (const result of results) {
					if (result.status !== "fulfilled") continue;
					await result.value.bus.close();
					await result.value.state.close();
				}
				assert.deepEqual(failures, []);
			} finally {
				await scope.close();
			}
		},
		CONCURRENT_OPEN_TIMEOUT_MS,
	);
}
