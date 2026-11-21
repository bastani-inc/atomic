import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openDatabaseWakeUpBus } from "../../packages/intercom/broker/database-wake-up-bus.js";
import type { IntercomBrokerStateOptions } from "../../packages/intercom/broker/multinode-state-store.js";
import { borrowedDatabase } from "../../packages/intercom/broker/open-broker-state.js";
import { openSqlHeldSendStore } from "../../packages/intercom/broker/sql-held-send-store.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { openSqlPendingAskStore } from "../../packages/intercom/broker/sql-pending-ask-store.js";
import { openSqlReleasedAskStore } from "../../packages/intercom/broker/sql-released-ask-store.js";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { openSqlSentMessageAuthority } from "../../packages/intercom/broker/sql-sent-message-authority.js";
import { useFixtureStorageAdapter } from "../helpers/fixture-storage-adapter.js";
import {
	type OpenSharedStoreFixture,
	type ReturningSessionStores,
	registerCrossNodeHeldRoundTripConformance,
	registerCrossNodeRoundTripConformance,
	registerHeldSendStoreConformance,
	registerPendingAskStoreConformance,
	registerReleasedAskStoreConformance,
	registerRestoringReservationStoreConformance,
	registerReturningSessionConformance,
	registerSentMessageAuthorityConformance,
	type SharedStoreFixture,
} from "../helpers/intercom-multinode-contract.js";
import { openMemoryOutboxFixture, openMemoryWakeUpBusFixture } from "../helpers/intercom-multinode-memory-reference.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

type OpenStore<Store> = (options: IntercomBrokerStateOptions) => Promise<Store>;
type OpenConnection = (directory: string) => Promise<SqliteDatabase>;

function sharedFileFixture<Store>(
	openConnection: OpenConnection,
	openStore: OpenStore<Store>,
	prefix: string,
): OpenSharedStoreFixture<Store> {
	return async (): Promise<SharedStoreFixture<Store>> => {
		const directory = makeTempDirectory("intercom-multinode-s3-");
		const connections: SqliteDatabase[] = [];
		return {
			async connect() {
				const database = await openConnection(directory);
				connections.push(database);
				return openStore({ database, prefix });
			},
			async close() {
				await Promise.all(connections.map((database) => database.close()));
				removeTempDirectory(directory);
			},
		};
	};
}

const fixtureAdapter = useFixtureStorageAdapter();

/** The stores in the order a broker opens them, then its wake-up bus on the same connection (#5607). */
const openReturningSessionStores: OpenStore<ReturningSessionStores> = async (options) => ({
	leases: await openSqlBrokerLeaseStore(options),
	knownSessions: await openSqlKnownSessionStore(options),
	outbox: await openSqlOutboxStore(options),
	bus: await openDatabaseWakeUpBus({
		openDatabase: async () => borrowedDatabase(options.database),
		prefix: options.prefix,
	}),
});

const nodeSqlite: OpenConnection = (directory) => openNodeSqliteDatabase(join(directory, "intercom.sqlite"));

const moduleSelectedAdapter: OpenConnection = async (directory) => {
	const adapter = fixtureAdapter();
	assert.ok(adapter.openDatabase);
	return adapter.openDatabase({ path: join(directory, "shared.sqlite") }, { agentDir: directory, domain: "sessions" });
};

for (const [name, openConnection, prefix] of [
	["SQL on two node:sqlite connections to one file", nodeSqlite, ""],
	["SQL on the module-selected adapter", moduleSelectedAdapter, "team_"],
] as const) {
	registerPendingAskStoreConformance(test, name, sharedFileFixture(openConnection, openSqlPendingAskStore, prefix));
	registerReleasedAskStoreConformance(test, name, sharedFileFixture(openConnection, openSqlReleasedAskStore, prefix));
	registerSentMessageAuthorityConformance(
		test,
		name,
		sharedFileFixture(openConnection, openSqlSentMessageAuthority, prefix),
	);
	registerHeldSendStoreConformance(test, name, sharedFileFixture(openConnection, openSqlHeldSendStore, prefix));
	registerRestoringReservationStoreConformance(
		test,
		name,
		sharedFileFixture(openConnection, openSqlRestoringReservationStore, prefix),
	);
	registerCrossNodeHeldRoundTripConformance(test, name, {
		openReservations: sharedFileFixture(openConnection, openSqlRestoringReservationStore, prefix),
		openHeldSends: sharedFileFixture(openConnection, openSqlHeldSendStore, prefix),
		openOutbox: openMemoryOutboxFixture,
		openBus: openMemoryWakeUpBusFixture,
	});
	registerReturningSessionConformance(
		test,
		name,
		sharedFileFixture(openConnection, openReturningSessionStores, prefix),
	);
	registerCrossNodeRoundTripConformance(test, `${name} (SQL outbox and pending asks)`, {
		openOutbox: sharedFileFixture(openConnection, openSqlOutboxStore, prefix),
		openPendingAsks: sharedFileFixture(openConnection, openSqlPendingAskStore, prefix),
		openBus: openMemoryWakeUpBusFixture,
	});
}
