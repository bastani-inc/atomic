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
import {
	type OpenSharedStoreFixture,
	registerBrokerLeaseStoreConformance,
	registerCrossNodeHeldRoundTripConformance,
	registerCrossNodeRoundTripConformance,
	registerHeldSendStoreConformance,
	registerIdOwnerConformance,
	registerKnownSessionStoreConformance,
	registerOutboxStoreConformance,
	registerPendingAskStoreConformance,
	registerReleasedAskStoreConformance,
	registerRestoringReservationStoreConformance,
	registerReturningSessionConformance,
	registerSentMessageAuthorityConformance,
} from "../helpers/intercom-multinode-contract.js";
import { openMemoryOutboxFixture, openMemoryWakeUpBusFixture } from "../helpers/intercom-multinode-memory-reference.js";
import { type StorageBackend, storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { backendLabel } from "./storage-conformance-matrix-helpers.js";

/**
 * Intercom multi-node routing state behavioural contract on every storage backend (#4793): a SQLite file, a libSQL
 * server and Postgres.
 */

useTemporaryAgentDir();

/** A shared-state fixture whose every connection is another database connection to one backend scope. */
function scopeFixture<Store>(
	backend: StorageBackend,
	openStore: (options: IntercomBrokerStateOptions) => Promise<Store>,
): OpenSharedStoreFixture<Store> {
	return async () => {
		const scope = await backend.openScope();
		return {
			connect: async () => openStore({ database: await scope.connect(), prefix: scope.prefix }),
			close: () => scope.close(),
		};
	};
}

for (const backend of storageBackends) {
	const name = backendLabel(backend);
	const run = backend.skipReason === undefined ? test : test.skip;
	const intercom = `Intercom routing on ${name}`;
	registerBrokerLeaseStoreConformance(run, intercom, scopeFixture(backend, openSqlBrokerLeaseStore));
	registerKnownSessionStoreConformance(run, intercom, scopeFixture(backend, openSqlKnownSessionStore));
	// The lease store's table is there first, as in a broker: an unanswered claim's `reclaim` reads it.
	registerIdOwnerConformance(
		run,
		intercom,
		scopeFixture(backend, async (options) => {
			await openSqlBrokerLeaseStore(options);
			return openSqlKnownSessionStore(options);
		}),
	);
	registerOutboxStoreConformance(run, intercom, scopeFixture(backend, openSqlOutboxStore));
	registerPendingAskStoreConformance(run, intercom, scopeFixture(backend, openSqlPendingAskStore));
	registerReleasedAskStoreConformance(run, intercom, scopeFixture(backend, openSqlReleasedAskStore));
	registerSentMessageAuthorityConformance(run, intercom, scopeFixture(backend, openSqlSentMessageAuthority));
	registerHeldSendStoreConformance(run, intercom, scopeFixture(backend, openSqlHeldSendStore));
	registerRestoringReservationStoreConformance(run, intercom, scopeFixture(backend, openSqlRestoringReservationStore));
	// The stores in the order a broker opens them, then its wake-up bus on the same connection (#5607).
	registerReturningSessionConformance(
		run,
		intercom,
		scopeFixture(backend, async (options) => ({
			leases: await openSqlBrokerLeaseStore(options),
			knownSessions: await openSqlKnownSessionStore(options),
			outbox: await openSqlOutboxStore(options),
			bus: await openDatabaseWakeUpBus({
				openDatabase: async () => borrowedDatabase(options.database),
				prefix: options.prefix,
			}),
		})),
	);
	registerCrossNodeRoundTripConformance(run, intercom, {
		openOutbox: scopeFixture(backend, openSqlOutboxStore),
		openPendingAsks: scopeFixture(backend, openSqlPendingAskStore),
		openBus: openMemoryWakeUpBusFixture,
	});
	registerCrossNodeHeldRoundTripConformance(run, intercom, {
		openReservations: scopeFixture(backend, openSqlRestoringReservationStore),
		openHeldSends: scopeFixture(backend, openSqlHeldSendStore),
		openOutbox: openMemoryOutboxFixture,
		openBus: openMemoryWakeUpBusFixture,
	});
}
