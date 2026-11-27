import assert from "node:assert/strict";
import type { Duplex } from "node:stream";
import { inspect } from "node:util";
import { type FencedPathId, StorageTransientError, StorageUnavailableError } from "@bastani/atomic/storage";
import { describe, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { transactionFinisher } from "../../packages/coding-agent/src/core/storage/statement-sequence.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import {
	postgresTestUsesTls,
	proxiedUrl,
	startPostgresProxy,
	writeProxyCertificates,
} from "../helpers/postgres-proxy.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * A fault-injecting PostgreSQL wire-protocol proxy that parses backend v3 messages (`type` + 4-byte length)
 * so each drop fires deterministically at an exact protocol boundary (such as after PostgreSQL answers
 * `CommandComplete("COMMIT")` durably, before the reply reaches the client).
 */
type FaultPlan =
	| { readonly kind: "drop-after-commit"; readonly forwardReadyBeforeHold: number; readonly cut?: true }
	| { readonly kind: "drop-on-client-marker"; readonly marker: string };

async function startFaultProxy(): Promise<{
	url(databaseUrl: string): string;
	arm(plan: FaultPlan): void;
	cut(): void;
	reconnect(): void;
	readonly dropped: number;
	close(): Promise<void>;
}> {
	const directory = makeTempDirectory("atomic-pg-commit-drop-");
	const certificate = postgresTestUsesTls() ? writeProxyCertificates(directory) : undefined;
	let activePlan: FaultPlan | undefined;
	let dropped = 0;
	let offline = false;
	const clients = new Set<Duplex>();
	const cut = () => {
		offline = true;
		for (const client of clients) client.destroy();
	};

	const proxy = await startPostgresProxy(certificate, (client, upstream, first) => {
		if (offline) {
			client.destroy();
			return;
		}
		clients.add(client);
		client.once("close", () => clients.delete(client));
		let connPlan: FaultPlan | undefined;
		let readyForwarded = 0;
		let holding = false;
		let pending: Buffer = Buffer.alloc(0);

		const dropNow = () => {
			dropped++;
			if (connPlan?.kind === "drop-after-commit" && connPlan.cut) cut();
			connPlan = undefined;
			client.destroy();
			upstream.destroy();
		};

		const fromClient = (chunk: Buffer) => {
			const text = chunk.toString("latin1");
			if (connPlan === undefined && activePlan !== undefined) {
				if (activePlan.kind === "drop-on-client-marker") {
					if (text.includes(activePlan.marker)) {
						activePlan = undefined;
						dropNow();
						return;
					}
				} else if (text.includes("BEGIN")) {
					connPlan = activePlan;
					activePlan = undefined;
					readyForwarded = 0;
					holding = connPlan.forwardReadyBeforeHold === 0;
				}
			}
			upstream.write(chunk);
		};

		const fromUpstream = (chunk: Buffer) => {
			if (connPlan === undefined) {
				client.write(chunk);
				return;
			}
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			const forward: Buffer[] = [];
			let offset = 0;
			while (offset + 5 <= pending.length) {
				const type = pending[offset]!;
				const length = pending.readInt32BE(offset + 1);
				const total = 1 + length;
				if (offset + total > pending.length) break;
				const frame = pending.subarray(offset, offset + total);
				offset += total;

				// 'C' = CommandComplete; payload is NUL-terminated command tag (e.g. "COMMIT\0").
				if (type === 0x43 && length >= 5) {
					const tag = frame.toString("ascii", 5, total - 1);
					if (tag === "COMMIT") {
						if (forward.length > 0) client.write(Buffer.concat(forward));
						pending = Buffer.alloc(0);
						dropNow();
						return;
					}
				}
				if (!holding) {
					forward.push(frame);
					// 'Z' = ReadyForQuery; counts completed top-level statements before holding later replies.
					if (type === 0x5a && connPlan.kind === "drop-after-commit") {
						readyForwarded++;
						if (readyForwarded >= connPlan.forwardReadyBeforeHold) holding = true;
					}
				}
			}
			if (forward.length > 0) client.write(Buffer.concat(forward));
			pending = offset === 0 ? pending : pending.subarray(offset);
		};

		fromClient(first);
		client.on("data", fromClient);
		upstream.on("data", fromUpstream);
	});

	return {
		url: (databaseUrl) => proxiedUrl(databaseUrl, proxy.port, certificate?.ca),
		arm(plan) {
			activePlan = plan;
		},
		cut,
		reconnect() {
			offline = false;
		},
		get dropped() {
			return dropped;
		},
		async close() {
			await proxy.close();
			removeTempDirectory(directory);
		},
	};
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL session append recovery (#6752)", () => {
	test("a lost COMMIT acknowledgement is checked after reconnect, not replayed or overtaken (#6752)", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const proxy = await startFaultProxy();
			try {
				const direct = await SqlSessionStore.open(await open());
				const store = await SqlSessionStore.open(await open({ url: proxy.url(url) }));
				const writer = await SessionManager.create(store, process.cwd());
				const sessionId = writer.getSessionId();
				await writer.appendCustomEntry("probe", "before");
				proxy.arm({ kind: "drop-after-commit", forwardReadyBeforeHold: Number.POSITIVE_INFINITY, cut: true });
				const settled = Promise.all([
					writer.appendCustomEntry("probe", "committed before the drop"),
					writer.appendCustomEntry("probe", "after reconnect"),
				]);
				const outcome = settled.catch((error: unknown) => error);
				const saved = async () =>
					(await direct.load(sessionId)).entries.flatMap((entry) =>
						entry.type === "custom" && entry.customType === "probe" ? [entry.data] : [],
					);
				try {
					await vi.waitFor(() => assert.equal(proxy.dropped, 1));
					assert.deepEqual(await saved(), ["before", "committed before the drop"]);
					// Outlast the facade's own retry budget for the read of the uncertain append.
					await sleep(5_500);
					proxy.reconnect();
					await settled;
					assert.deepEqual(await saved(), ["before", "committed before the drop", "after reconnect"]);
				} finally {
					proxy.reconnect();
					await outcome;
				}
			} finally {
				await proxy.close();
			}
		});
	});

	/** Keeping the real query path disconnected for the full standalone recovery budget is the behavior under test. */
	const BARE_OUTAGE_TEST_TIMEOUT_MS = 85_000;
	test(
		"a bare writer gives up after about a minute of continuing connection failures (#6752)",
		async () => {
			await withPostgresDatabase(async ({ open, url }) => {
				const proxy = await startFaultProxy();
				try {
					const database = await open({ url: proxy.url(url) });
					const store = await SqlSessionStore.open(database);
					const writer = await SessionManager.create(store, process.cwd());
					proxy.cut();
					const started = performance.now();
					await assert.rejects(writer.appendCustomEntry("probe", "cannot save"), { code: "connection-refused" });
					assert.ok(
						performance.now() - started >= 59_000,
						"the transient failure should not surface before the bare writer's wait",
					);
				} finally {
					await proxy.close();
				}
			});
		},
		BARE_OUTAGE_TEST_TIMEOUT_MS,
	);
});

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL dropped connection after COMMIT (#6711)", () => {
	test("savepoint-recovered lock timeout followed by connection drop after COMMIT reports unknown and does not retry (#6711)", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const proxy = await startFaultProxy();
			try {
				const direct = await open();
				await direct.exec("CREATE TABLE items (id BIGSERIAL PRIMARY KEY, label TEXT NOT NULL)");
				const database = await open({ url: proxy.url(url), maxConnections: 2 });
				// Warm the connection so the first-connect prepared-statement probe is finished.
				await database.get("SELECT 1 AS ok");

				let runs = 0;
				proxy.arm({ kind: "drop-after-commit", forwardReadyBeforeHold: Number.POSITIVE_INFINITY });
				const error = await database
					.transaction(
						async (tx) => {
							runs++;
							await tx.exec("SAVEPOINT atomic_test_recover");
							try {
								await tx.exec("DO $$ BEGIN RAISE EXCEPTION 'lock timeout' USING ERRCODE = '55P03'; END $$");
							} catch {
								await tx.exec("ROLLBACK TO SAVEPOINT atomic_test_recover");
							}
							await tx.exec("RELEASE SAVEPOINT atomic_test_recover");
							const finish = transactionFinisher(tx);
							assert.ok(finish);
							assert.equal(
								finish([{ sql: "INSERT INTO items(label) VALUES (?)", params: [`run-${runs}`] }]),
								true,
							);
						},
						{ retryTransientFailures: true },
					)
					.catch((caught: unknown) => caught);

				assert.equal(proxy.dropped, 1, "proxy must drop right after PostgreSQL commits");
				assert.equal(runs, 1, "already-committed transaction must never retry");
				assert.ok(error instanceof StorageTransientError, inspect(error));
				assert.equal(error.code, "connection-lost");
				assert.equal(error.outcome, "unknown");
				assert.deepEqual(await direct.all("SELECT label FROM items ORDER BY id"), [{ label: "run-1" }]);
			} finally {
				await proxy.close();
			}
		});
	});

	test("pipelined savepoint failure with failed RELEASE recovered by ROLLBACK TO SAVEPOINT does not pollute a dropped COMMIT (#6711)", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const proxy = await startFaultProxy();
			try {
				const direct = await open();
				await direct.exec("CREATE TABLE items (id BIGSERIAL PRIMARY KEY, label TEXT NOT NULL)");
				const database = await open({ url: proxy.url(url), maxConnections: 2 });
				await database.get("SELECT 1 AS ok");

				let runs = 0;
				proxy.arm({ kind: "drop-after-commit", forwardReadyBeforeHold: Number.POSITIVE_INFINITY });
				const error = await database
					.transaction(
						async (tx) => {
							runs++;
							const sp = tx.exec("SAVEPOINT atomic_pipelined_recover");
							const bad = tx.exec("DO $$ BEGIN RAISE EXCEPTION 'deadlock' USING ERRCODE = '40P01'; END $$");
							const rel = tx.exec("RELEASE SAVEPOINT atomic_pipelined_recover");
							const outcomes = await Promise.allSettled([sp, bad, rel]);
							assert.equal(outcomes[0].status, "fulfilled");
							assert.equal(outcomes[1].status, "rejected");
							assert.equal(outcomes[2].status, "rejected");
							await tx.exec("ROLLBACK TO SAVEPOINT atomic_pipelined_recover");
							await tx.exec("RELEASE SAVEPOINT atomic_pipelined_recover");
							await tx.run("INSERT INTO items(label) VALUES (?)", `pipelined-${runs}`);
						},
						{ retryTransientFailures: true },
					)
					.catch((caught: unknown) => caught);

				assert.equal(proxy.dropped, 1);
				assert.equal(runs, 1, "already-committed transaction must never retry");
				assert.ok(error instanceof StorageTransientError, inspect(error));
				assert.equal(error.code, "connection-lost");
				assert.equal(error.outcome, "unknown");
				assert.deepEqual(await direct.all("SELECT label FROM items ORDER BY id"), [{ label: "pipelined-1" }]);
			} finally {
				await proxy.close();
			}
		});
	});

	test("savepoint-recovered error does not mask a later finish-write constraint failure (#6711)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			await database.exec("CREATE TABLE items (id BIGINT PRIMARY KEY, label TEXT NOT NULL)");
			await database.run("INSERT INTO items(id, label) VALUES (?, ?)", 1, "existing");

			let runs = 0;
			const error = await database
				.transaction(
					async (tx) => {
						runs++;
						await tx.exec("SAVEPOINT atomic_mask_check");
						try {
							await tx.exec("DO $$ BEGIN RAISE EXCEPTION 'lock timeout' USING ERRCODE = '55P03'; END $$");
						} catch {
							await tx.exec("ROLLBACK TO SAVEPOINT atomic_mask_check");
						}
						await tx.exec("RELEASE SAVEPOINT atomic_mask_check");
						transactionFinisher(tx)?.([
							{ sql: "INSERT INTO items(id, label) VALUES (?, ?)", params: [1, "dup"] },
						]);
					},
					{ retryTransientFailures: true },
				)
				.catch((caught: unknown) => caught);

			assert.equal(runs, 1, "permanent duplicate-key failure must not retry due to recovered lock timeout");
			assert.ok(error instanceof StorageUnavailableError, inspect(error));
			assert.equal(error instanceof StorageTransientError, false, inspect(error));
			assert.match(inspect(error, { depth: null }), /duplicate key/i);
		});
	});

	for (const [label, forwardReadyBeforeHold] of [
		["before BEGIN answer arrives", 0],
		["after BEGIN answer, before leading statement answer arrives", 1],
		["after leading statement answer, before COMMIT answer arrives", Number.POSITIVE_INFINITY],
	] as const) {
		test(`leadingOnly transaction dropped after COMMIT commits (${label}) reports unknown and does not retry (#6711)`, async () => {
			await withPostgresDatabase(async ({ open, url }) => {
				const proxy = await startFaultProxy();
				try {
					const direct = await open();
					await direct.exec("CREATE TABLE items (id BIGSERIAL PRIMARY KEY, label TEXT NOT NULL)");
					const database = await open({ url: proxy.url(url), maxConnections: 2 });
					await database.get("SELECT 1 AS ok");

					let runs = 0;
					const insert = { sql: "INSERT INTO items(label) VALUES (?)", params: ["leading-only"] } as const;
					proxy.arm({ kind: "drop-after-commit", forwardReadyBeforeHold });
					const error = await database
						.transaction(
							async (tx) => {
								runs++;
								await tx.run(insert.sql, ...insert.params);
							},
							{ retryTransientFailures: true, leading: [insert], leadingOnly: true },
						)
						.catch((caught: unknown) => caught);

					assert.equal(proxy.dropped, 1, "proxy must drop right after PostgreSQL commits");
					assert.ok(runs <= 1, `already-committed leadingOnly transaction must never retry (runs=${runs})`);
					assert.ok(error instanceof StorageTransientError, inspect(error));
					assert.equal(error.code, "connection-lost");
					assert.equal(error.outcome, "unknown");
					assert.deepEqual(await direct.all("SELECT label FROM items ORDER BY id"), [{ label: "leading-only" }]);
				} finally {
					await proxy.close();
				}
			});
		});
	}

	test("genuine pre-COMMIT connection drop still classifies as not-applied and retries cleanly (#6711)", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const proxy = await startFaultProxy();
			try {
				const direct = await open();
				await direct.exec("CREATE TABLE items (id BIGSERIAL PRIMARY KEY, label TEXT NOT NULL)");
				const database = await open({ url: proxy.url(url), maxConnections: 2 });
				await database.get("SELECT 1 AS ok");

				let runs = 0;
				const marker = "/* drop-pre-commit-6711 */";
				proxy.arm({ kind: "drop-on-client-marker", marker });
				const committedRun = await database.transaction(
					async (tx) => {
						runs++;
						await tx.run(`INSERT INTO items(label) VALUES (?) ${marker}`, `attempt-${runs}`);
						return runs;
					},
					{ retryTransientFailures: true },
				);

				assert.equal(proxy.dropped, 1);
				assert.equal(committedRun, 2);
				assert.equal(runs, 2);
				assert.deepEqual(await direct.all("SELECT label FROM items ORDER BY id"), [{ label: "attempt-2" }]);
			} finally {
				await proxy.close();
			}
		});
	});

	test("leadingOnly readOnly transaction dropped after COMMIT does not double-release the pooled client (#6711)", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const proxy = await startFaultProxy();
			try {
				const database = await open({ url: proxy.url(url), maxConnections: 1 });
				await database.get("SELECT 1 AS ok");

				const read = { sql: "SELECT 1 AS value", params: [] } as const;
				proxy.arm({ kind: "drop-after-commit", forwardReadyBeforeHold: 0 });
				const error = await database
					.transaction(async (tx) => tx.get(read.sql, ...read.params), {
						readOnly: true,
						retryTransientFailures: true,
						leading: [read],
						leadingOnly: true,
					})
					.catch((caught: unknown) => caught);

				assert.equal(proxy.dropped, 1);
				assert.ok(error instanceof StorageTransientError, inspect(error));
				assert.equal(error.code, "connection-lost");
				assert.equal(error.outcome, "unknown");
				// The broken client was destroyed once rather than returned healthy or double-released.
				assert.deepEqual(await database.get("SELECT 2 AS ok"), { ok: 2 });
			} finally {
				await proxy.close();
			}
		});
	});

	test("leadingOnly transaction refused by server lock timeout before commit still classifies as not-applied and retries (#6711)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const holder = await open();
			const database = await open();
			await holder.exec("CREATE TABLE items (id BIGINT PRIMARY KEY, val BIGINT NOT NULL)");
			await holder.run("INSERT INTO items(id, val) VALUES (?, ?)", 1, 0);

			const locked = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const fenced = { kind: "fenced", audit: "test-leading-lock-timeout" as FencedPathId } as const;
			const holdTx = holder.transaction(
				async (tx) => {
					await tx.get("SELECT id FROM items WHERE id = ? FOR UPDATE", 1);
					locked.resolve();
					await release.promise;
				},
				{ concurrency: fenced },
			);
			await locked.promise;

			let runs = 0;
			const update = { sql: "UPDATE items SET val = val + 1 WHERE id = ?", params: [1] } as const;
			// Release the row lock right after the first lock timeout fires so the retry succeeds.
			const releaseTimer = setTimeout(() => release.resolve(), 150);
			try {
				const result = await database.transaction(
					async (tx) => {
						runs++;
						await tx.run(update.sql, ...update.params);
						return runs;
					},
					{
						concurrency: fenced,
						retryTransientFailures: true,
						lockWaitMs: 80,
						leading: [update],
						leadingOnly: true,
					},
				);
				assert.ok(result >= 2, `expected retry after lock timeout, got runs=${result}`);
			} finally {
				clearTimeout(releaseTimer);
				release.resolve();
				await holdTx;
			}
			assert.deepEqual(await holder.get("SELECT val FROM items WHERE id = ?", 1), { val: 1 });
		});
	});
});
