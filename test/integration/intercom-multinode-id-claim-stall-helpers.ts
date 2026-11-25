import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dialectOf, type SqliteDatabase } from "@bastani/atomic/storage";
import { vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import {
	PRESENCE_REGISTRATION_BOUND_MS,
	SESSION_ID_CLAIM_BOUND_MS,
} from "../../packages/intercom/broker/multinode-router.js";
import {
	SHARED_LEASES_TABLE,
	TWO_BROKER_STORAGE_PREFIX,
	type TwoBrokerClient,
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

export const HARNESS_OPTIONS: TwoBrokerHarnessOptions = { stallableIdClaims: true, parkableRegistrations: true };
/** Spawning a real broker process is the structural cost of this suite. */
export const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
/**
 * A registration that waits out both its claim and its presence bound leaves its client this much of its wait for
 * everything else: the broker's store I/O, message handling and IPC, which take far longer on a loaded runner.
 */
export const REAL_WORK_HEADROOM_MS = 2_000;
/**
 * The broker stops running for this long right after the database wrote the id: far longer than the claim may wait, even
 * when it moves its deadline on (`SESSION_ID_CLAIM_PROGRESS_CAP_MS`), and short enough that a broker that decides once it
 * runs again still has the real work's headroom left of its client's own wait.
 */
export const BROKER_STALL_MS = BROKER_CONNECT_TIMEOUT_MS - REAL_WORK_HEADROOM_MS;
/** A claim stalled just past its own bound, so that it gives up on its deadline when the broker runs again. */
export const PAST_CLAIM_BOUND_STALL_MS = SESSION_ID_CLAIM_BOUND_MS + 100;
/**
 * How long the broker is busy before it accepts a registration that then stalls past its claim bound and waits its whole
 * presence bound: what the client's wait leaves of those and of the real work's headroom.
 */
export const BUSY_BEFORE_ACCEPT_MS =
	BROKER_CONNECT_TIMEOUT_MS - PAST_CLAIM_BOUND_STALL_MS - PRESENCE_REGISTRATION_BOUND_MS - REAL_WORK_HEADROOM_MS;

export type SlowWrite = "fresh binding" | "serial bindings" | "known session";

export const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

export class IdClaimStallSupport {
	private sharedDatabase: SqliteDatabase | undefined;

	private constructor(readonly harness: TwoBrokerHarness) {}

	static async start(): Promise<IdClaimStallSupport> {
		return new IdClaimStallSupport(await TwoBrokerHarness.start(HARNESS_OPTIONS));
	}

	cleanup(): Promise<void> {
		return this.harness.cleanup();
	}

	private async database(): Promise<SqliteDatabase> {
		this.sharedDatabase ??= await this.harness.openSharedStorage("b");
		return this.sharedDatabase;
	}

	/**
	 * Resolves once no broker holds the presence lease of a session with `returnAddress` in the shared database. A
	 * departing session's broker gives up the session's id before it releases that lease, so a registration that brings it
	 * back finds the id free. Another node's `list` cannot tell: when the database is slow to answer, it answers without
	 * any remote session.
	 */
	async presenceReleased(returnAddress: string): Promise<void> {
		const database = await this.database();
		// The start of every delivery identity of that session, whatever its group, as the presence lease's key writes it.
		const identities = `${JSON.stringify(["return", returnAddress]).slice(0, -1)},`;
		await vi.waitFor(
			async () => {
				const row = await database.get<{ live: number | bigint }>(
					`SELECT count(*) AS live FROM "${SHARED_LEASES_TABLE}"
					 WHERE kind = 'presence' AND holder_id IS NOT NULL AND substr(key, 1, length(?)) = ?`,
					identities,
					identities,
				);
				assert.equal(Number(row?.live ?? 0), 0, "a broker still presents the session that left");
			},
			{ timeout: 15_000 },
		);
	}

	/**
	 * What the shared database holds for a session that returns with id `id` from `returnAddress`, for a failure to name:
	 * the bindings of the id and of any fresh id the session got (the claim that last bound each, its owner, and when that
	 * owner last renewed it), the presence leases of the return address, the session's known-session rows and the brokers'
	 * membership leases, with the database's clock. The claim of the id, the reclaim of an unanswered claim and the
	 * departure of the session's earlier registration each decide from these rows (#5607).
	 */
	async sharedRowsFor(id: string, returnAddress: string): Promise<string> {
		const database = await this.database();
		const { nowMs } = dialectOf(database);
		const identities = `${JSON.stringify(["return", returnAddress]).slice(0, -1)},`;
		const [clock, bindings, presence, known, brokers] = await Promise.all([
			database.get(`SELECT ${nowMs} AS now`),
			database.all(
				`SELECT * FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_session_bindings WHERE intercom_session_id = ? OR return_address = ?`,
				id,
				returnAddress,
			),
			database.all(
				`SELECT key, holder_id, fencing_token, renewed_at FROM "${SHARED_LEASES_TABLE}"
				 WHERE kind = 'presence' AND substr(key, 1, length(?)) = ?`,
				identities,
				identities,
			),
			database.all(
				`SELECT * FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_known_sessions WHERE intercom_session_id = ? OR atomic_session_id = ?`,
				id,
				returnAddress,
			),
			database.all(`SELECT key, holder_id, renewed_at FROM "${SHARED_LEASES_TABLE}" WHERE kind = 'broker'`),
		]);
		return JSON.stringify({ clock, bindings, presence, known, brokers }, (_key, value: unknown) =>
			typeof value === "bigint" ? Number(value) : value,
		);
	}

	/**
	 * Runs `region`, the return of the session with id `id` from `returnAddress`: one that fails says how long it ran and
	 * what the shared database held for the session then, so a failure on a loaded runner can be told apart from a lost id.
	 */
	async explained(id: string, returnAddress: string, region: () => Promise<void>): Promise<void> {
		const started = performance.now();
		try {
			await region();
		} catch (error) {
			const elapsedMs = Math.round(performance.now() - started);
			const rows = await this.sharedRowsFor(id, returnAddress).catch(
				(read: Error) => `(unreadable: ${read.message})`,
			);
			if (error instanceof Error) error.message = `${error.message}\nafter ${elapsedMs} ms; shared rows: ${rows}`;
			throw error;
		}
	}

	/** The database's clock, and when it last recorded the session with id `id` as known (undefined: never). */
	async knownRecord(id: string): Promise<{ now: number; recordedAt: number | undefined }> {
		const database = await this.database();
		const row = await database.get<{ now: number | bigint; recorded_at: number | bigint | null }>(
			`SELECT ${dialectOf(database).nowMs} AS now,
				(SELECT max(recorded_at) FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_known_sessions WHERE intercom_session_id = ?) AS recorded_at`,
			id,
		);
		assert.ok(row !== undefined);
		return { now: Number(row.now), recordedAt: row.recorded_at === null ? undefined : Number(row.recorded_at) };
	}

	/**
	 * `original` leaves as a session that will return, and this resolves once its broker has finished its departure (its
	 * presence is gone from `observer`'s list and from the shared database, and the departure has recorded the session, its
	 * last write), so the registration that brings it back does not queue behind that work, and `holdRegistration` parks
	 * that registration's record of the session, never the departure's.
	 */
	async leaveAway(original: TwoBrokerClient, observer: TwoBrokerClient): Promise<string> {
		const id = original.sessionId;
		// The departure's record of the session is told from its registration's by a later time on the database's clock.
		const registeredAt = await vi.waitFor(
			async () => {
				const { recordedAt } = await this.knownRecord(id);
				assert.ok(recordedAt !== undefined, "the registration has not recorded the session yet");
				return recordedAt;
			},
			{ timeout: 15_000 },
		);
		await vi.waitFor(async () => assert.ok((await this.knownRecord(id)).now > registeredAt), { timeout: 15_000 });
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;
		await vi.waitFor(
			async () => assert.ok(!(await observer.client.listSessions()).some((session) => session.id === id)),
			{ timeout: 15_000 },
		);
		await this.presenceReleased(original.returnAddress);
		await vi.waitFor(
			async () => {
				const { recordedAt } = await this.knownRecord(id);
				assert.ok(
					recordedAt !== undefined && recordedAt > registeredAt,
					"the departure has not recorded the session yet",
				);
			},
			{ timeout: 15_000 },
		);
		return id;
	}

	async reconnectWithSlowWrite(
		slowWrite: SlowWrite,
		socketPath?: string,
	): Promise<{ back: TwoBrokerClient; preferredSessionId: string }> {
		const observer = await this.harness.connect("a", unique("observer"));
		const original = await this.harness.connect("b", unique("returning"));
		const preferredSessionId = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;
		// Start on the other broker after the old lease is released. Otherwise the timed registration can wait on
		// the old connection's own departure instead of measuring the cost of the binding or the known-session write.
		await vi.waitFor(
			async () => {
				assert.ok(!(await observer.client.listSessions()).some((session) => session.id === preferredSessionId));
			},
			{ timeout: 15_000 },
		);
		await this.presenceReleased(original.returnAddress);
		if (slowWrite === "serial bindings")
			this.harness.stallIdClaim(original.returnAddress, 3_500, undefined, 3_050, slowWrite);
		else this.harness.stallIdClaim(original.returnAddress, 2_800, 3_200, 3_050, slowWrite);
		let back: TwoBrokerClient | undefined;
		await this.explained(preferredSessionId, original.returnAddress, async () => {
			back = await this.harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
				socketPath,
			});
			assert.ok(this.harness.idClaimStalled(original.returnAddress));
			// The database wrote the id for this registration before the broker stalled, whichever write is slow after it.
			assert.equal(back.sessionId, preferredSessionId);
		});
		assert.ok(back !== undefined);
		return { back, preferredSessionId };
	}
}
