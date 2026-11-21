import assert from "node:assert/strict";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { describe, it, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.ts";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
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
	registerKnownSessionStoreConformance,
	registerOutboxStoreConformance,
	registerPendingAskStoreConformance,
	registerReleasedAskStoreConformance,
	registerRestoringReservationStoreConformance,
	registerReturningSessionConformance,
	registerSentMessageAuthorityConformance,
} from "../helpers/intercom-multinode-contract.js";
import { openMemoryOutboxFixture, openMemoryWakeUpBusFixture } from "../helpers/intercom-multinode-memory-reference.js";
import { databaseSubject, type StorageBackend, storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * Every store's behavioural contract on every storage backend (#4793): the database facade, sessions and Intercom's
 * multi-node routing state, each on a SQLite file, a libSQL server and Postgres.
 */

useTemporaryAgentDir();

/**
 * Rows that fail on a backend because of an open bug, by suite and test name, with the issue. They run as `it.fails`,
 * so the row turns red once the bug is fixed and the fix removes its entry.
 */
const KNOWN_FAILURES: ReadonlyMap<string, string> = new Map();

/** A describe/it runner for `backend`: skipped rows when the backend is, known failures as `it.fails`. */
function runnerFor(backend: StorageBackend) {
	const { skipReason } = backend;
	let suite = "";
	return {
		describe(name: string, body: () => void) {
			describe(name, () => {
				const outer = suite;
				suite = name;
				try {
					body();
				} finally {
					suite = outer;
				}
			});
		},
		it(name: string, body: () => Promise<void>, timeoutMs?: number) {
			const issue = KNOWN_FAILURES.get(`${suite} > ${name}`);
			if (skipReason !== undefined) it.skip(name, body);
			else if (issue !== undefined) it.fails(`${name} (known failure, ${issue})`, body, timeoutMs);
			else it(name, body, timeoutMs);
		},
	};
}

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
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	const run = backend.skipReason === undefined ? test : test.skip;
	const runner = runnerFor(backend);
	registerSqliteDatabaseConformance(runnerFor(backend), `database facade on ${name}`, databaseSubject(backend));

	registerSessionStoreConformance(runner, `SqlSessionStore on ${name}`, async (body) => {
		const scope = await backend.openScope();
		try {
			const open = async (database: SqliteDatabase) => SqlSessionStore.open(database, { prefix: scope.prefix });
			let store = await open(await scope.connect());
			await body({
				get store() {
					return store;
				},
				async reopen() {
					store = await open(await scope.connect());
					return store;
				},
			});
		} finally {
			await scope.close();
		}
	});

	run(`projects an older session's resume state on ${name} without decoding its transcript (#5249)`, async () => {
		const scope = await backend.openScope();
		try {
			const database = await scope.connect();
			const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
			const header = {
				id: "projected",
				version: 4 as const,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: "/project",
			};
			const entries: SessionEntry[] = [
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp: header.createdAt,
					provider: "{provider}",
					modelId: "[model]",
				},
				{
					type: "thinking_level_change",
					id: "thinking",
					parentId: "model",
					timestamp: header.createdAt,
					thinkingLevel: "high",
				},
				{
					type: "custom",
					customType: "intercom_session_identity",
					id: "identity",
					parentId: "thinking",
					timestamp: header.createdAt,
					data: { sessionId: header.id },
				},
				{
					type: "custom",
					customType: "atomic-pooled-delivery-op",
					id: "receipt",
					parentId: "identity",
					timestamp: header.createdAt,
					data: { op: "delivered-op" },
				},
				{
					type: "custom_message",
					id: "ask",
					parentId: "receipt",
					timestamp: header.createdAt,
					customType: "intercom_message",
					content: "old body".repeat(500),
					display: true,
					details: { message: { id: "ask-id", expectsReply: true } },
				},
				{
					type: "message",
					id: "kept",
					parentId: "ask",
					timestamp: header.createdAt,
					message: { role: "user", content: "kept", timestamp: 1 },
				},
				{
					type: "compaction",
					id: "boundary",
					parentId: "kept",
					timestamp: header.createdAt,
					summary: "summary",
					tokensBefore: 100,
					firstKeptEntryId: "kept",
					details: { strategy: "verbatim-lines" },
				},
			];
			await store.create(header, entries);
			const expected = await store.readResume(header.id);
			const table = renderStorageIdentifiers("sessions", { sessions: "sessions" }, scope.prefix).sessions;
			const row = await database.get<{ summary_state: string }>(
				`SELECT summary_state FROM ${table} WHERE id = ?`,
				header.id,
			);
			const { resume: _resume, ...summary } = JSON.parse(row!.summary_state) as Record<string, unknown>;
			await database.run(`UPDATE ${table} SET summary_state = ? WHERE id = ?`, JSON.stringify(summary), header.id);
			assert.deepEqual(expected.recovery.deliveryOpIds, ["delivered-op"]);
			assert.deepEqual(await store.readResume(header.id), expected);
			await store.close();
		} finally {
			await scope.close();
		}
	});

	const intercom = `Intercom routing on ${name}`;
	registerBrokerLeaseStoreConformance(run, intercom, scopeFixture(backend, openSqlBrokerLeaseStore));
	registerKnownSessionStoreConformance(run, intercom, scopeFixture(backend, openSqlKnownSessionStore));
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
