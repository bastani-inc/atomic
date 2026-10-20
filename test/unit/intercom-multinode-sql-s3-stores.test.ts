import assert from "node:assert/strict";
import { join } from "node:path";
import { loadStorageAdapter, openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { test } from "vitest";
import type { IntercomBrokerStateOptions } from "../../packages/intercom/broker/multinode-state-store.js";
import { openSqlHeldSendStore } from "../../packages/intercom/broker/sql-held-send-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { openSqlPendingAskStore } from "../../packages/intercom/broker/sql-pending-ask-store.js";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { openSqlSentMessageAuthority } from "../../packages/intercom/broker/sql-sent-message-authority.js";
import {
	type OpenSharedStoreFixture,
	registerCrossNodeHeldRoundTripConformance,
	registerCrossNodeRoundTripConformance,
	registerHeldSendStoreConformance,
	registerPendingAskStoreConformance,
	registerRestoringReservationStoreConformance,
	registerSentMessageAuthorityConformance,
	type SharedStoreFixture,
} from "../helpers/intercom-multinode-contract.js";
import { openMemoryOutboxFixture, openMemoryWakeUpBusFixture } from "../helpers/intercom-multinode-memory-reference.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

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

const nodeSqlite: OpenConnection = (directory) => openNodeSqliteDatabase(join(directory, "intercom.sqlite"));

const moduleSelectedAdapter: OpenConnection = async (directory) => {
	const adapter = await loadStorageAdapter(join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"), {
		agentDir: directory,
		domain: "sessions",
	});
	assert.ok(adapter.openDatabase);
	return adapter.openDatabase({ path: join(directory, "shared.sqlite") }, { agentDir: directory, domain: "sessions" });
};

for (const [name, openConnection, prefix] of [
	["SQL on two node:sqlite connections to one file", nodeSqlite, ""],
	["SQL on the module-selected adapter", moduleSelectedAdapter, "team_"],
] as const) {
	registerPendingAskStoreConformance(test, name, sharedFileFixture(openConnection, openSqlPendingAskStore, prefix));
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
	registerCrossNodeRoundTripConformance(test, `${name} (SQL outbox and pending asks)`, {
		openOutbox: sharedFileFixture(openConnection, openSqlOutboxStore, prefix),
		openPendingAsks: sharedFileFixture(openConnection, openSqlPendingAskStore, prefix),
		openBus: openMemoryWakeUpBusFixture,
	});
}
