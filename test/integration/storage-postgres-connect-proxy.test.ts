import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { createServer as createTlsServer } from "node:tls";
import { inspect } from "node:util";
import { type SqliteDatabase, StorageUnavailableError } from "@bastani/atomic/storage";
import { afterAll, beforeAll, describe, test } from "vitest";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { openDatabaseWakeUpBus } from "../../packages/intercom/broker/database-wake-up-bus.js";
import type { WakeUpHint } from "../../packages/intercom/broker/wake-up-bus.js";
import { openPostgresDatabase, type PostgresDatabaseOptions } from "../../packages/storage-postgres/postgres.js";

import { type ConnectProxy, closedPort, startConnectProxy } from "../helpers/http-connect-proxy.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	postgresTestUrl,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { startPostgresProxy } from "../helpers/postgres-proxy.js";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect, writeTextSync } from "../helpers/runtime.js";

/**
 * PostgreSQL through an HTTP `CONNECT` proxy (#5473). The database is named `db.invalid`, a name nothing resolves, so the
 * client reaches it only through the proxy, which maps it to a local PostgreSQL front that speaks TLS with a certificate
 * for that name and passes each session on to the test server.
 */

/** The database's host name: reserved, so a direct connection to it cannot succeed. */
const DATABASE_HOST = "db.invalid";
/** A name the front's certificate does not carry, routed to the same front. */
const OTHER_HOST = "other.invalid";
/** A name the proxy's allow-list does not carry. */
const BLOCKED_HOST = "blocked.invalid";
const PORT = 5432;
/** Another port the proxy routes {@link DATABASE_HOST} on, as `PGPORT` names it. */
const OTHER_PORT = 6543;
/** How long a hint may take to arrive through a notification, with the poll an hour away. */
const NOTIFIED_WAKE_BOUND_MS = 2_000;
const NEVER_POLL_MS = 60 * 60 * 1000;
/** How long the listening connection may take to connect, through the tunnel, and pass its probe. */
const LISTENING_BOUND_MS = 10_000;
/** The listener's first reconnect waits a second; through the tunnel the whole reconnect stays well inside this. */
const RELISTENING_BOUND_MS = 15_000;
/** A proxy's answer slower than the listening connection's 2 s probe wait (#5473). */
const SLOW_PROXY_ANSWER_MS = 2_500;
/**
 * Through {@link SLOW_PROXY_ANSWER_MS}, the listening connection's reconnect waits its first retry (1 s), its own tunnel,
 * and a pool connection's tunnel for the probe, plus TLS and sign-in on each.
 */
const SLOW_RELISTENING_BOUND_MS = 30_000;
/** An open that fails as unreachable runs five times with the facade's backoff, about four seconds. */
const TRANSIENT_RETRIES_TIMEOUT_MS = 30_000;
/** The statement timeout of the cancel test: the client gives up 5 s after it and sends a cancel request. */
const CANCEL_STATEMENT_TIMEOUT_MS = 1_000;
const CANCEL_TEST_TIMEOUT_MS = 30_000;
/** A comment that marks the statement whose answers the front drops, as a stalled network would. */
const STALL_MARKER = "/* stall-5473 */";
/** The protocol's SSLRequest and CancelRequest codes. */
const SSL_REQUEST_CODE = 80877103;
const CANCEL_REQUEST_CODE = 80877102;

function openssl(directory: string, ...args: string[]): void {
	const result = spawnSyncCollect(["openssl", ...args], { cwd: directory });
	assert.equal(result.exitCode, 0, result.stderr.toString());
}

/** A CA, and a certificate it signed that names only {@link DATABASE_HOST}. */
function writeCertificates(directory: string): { ca: string; cert: Buffer; key: Buffer } {
	openssl(
		directory,
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"2",
		"-subj",
		"/CN=Atomic test CA",
		"-keyout",
		"ca.key",
		"-out",
		"ca.pem",
	);
	openssl(
		directory,
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-subj",
		`/CN=${DATABASE_HOST}`,
		"-keyout",
		"server.key",
		"-out",
		"server.csr",
	);
	writeTextSync(join(directory, "server.ext"), `subjectAltName=DNS:${DATABASE_HOST}\n`);
	openssl(
		directory,
		"x509",
		"-req",
		"-in",
		"server.csr",
		"-CA",
		"ca.pem",
		"-CAkey",
		"ca.key",
		"-CAcreateserial",
		"-days",
		"2",
		"-extfile",
		"server.ext",
		"-out",
		"server.pem",
	);
	return {
		ca: join(directory, "ca.pem"),
		cert: readFileSync(join(directory, "server.pem")),
		key: readFileSync(join(directory, "server.key")),
	};
}

/** Runs `body` with `variables` set in the environment (undefined: removed), and restores it after. */
async function withEnvironment<T>(variables: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
	const saved = new Map<string, string | undefined>();
	for (const name of [
		"HTTPS_PROXY",
		"https_proxy",
		"HTTP_PROXY",
		"http_proxy",
		"ALL_PROXY",
		"all_proxy",
		"NO_PROXY",
		"no_proxy",
		"PGHOST",
		"PGPORT",
	]) {
		saved.set(name, process.env[name]);
		delete process.env[name];
	}
	for (const [name, value] of Object.entries(variables)) {
		if (!saved.has(name)) saved.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return await body();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** The error a promise rejected with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
	const outcome = await promise.then(
		(value) => ({ value }),
		(error: Error) => ({ error }),
	);
	assert.ok("error" in outcome, "the call succeeded");
	return outcome.error;
}

/** This machine's first IPv4 address that is not loopback, which only NO_PROXY can exempt; undefined without one. */
const MACHINE_ADDRESS = Object.values(networkInterfaces())
	.flat()
	.find((address) => address !== undefined && address.family === "IPv4" && !address.internal)?.address;

/** Whether `host` is this machine by a loopback name or address, as the test server's URL names it. */
function isLoopbackHost(host: string): boolean {
	const name = host.replace(/^\[|\]$/g, "").toLowerCase();
	return name === "localhost" || name === "::1" || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** Why `bytes` is not a run of whole TLS records (a last record cut short by a closed tunnel counts), or undefined. */
function tlsRecordProblem(bytes: Buffer): string | undefined {
	let offset = 0;
	while (offset + 5 <= bytes.length) {
		const type = bytes[offset]!;
		if (type < 20 || type > 23 || bytes[offset + 1] !== 3) return `byte ${offset} starts no TLS record`;
		offset += 5 + bytes.readUInt16BE(offset + 3);
	}
	return undefined;
}

/** A TCP forwarder on `host` to the front on 127.0.0.1:`port`, counting the connections it passed on. */
async function startForwarder(
	host: string,
	port: number,
): Promise<{ port: number; connections(): number; close(): Promise<void> }> {
	const sockets = new Set<Socket>();
	let count = 0;
	const server = createServer((client) => {
		count++;
		const upstream = connect(port, "127.0.0.1");
		for (const socket of [client, upstream]) {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => {
				client.destroy();
				upstream.destroy();
			});
		}
		client.pipe(upstream).pipe(client);
	});
	await new Promise<void>((resolve) => server.listen(0, host, resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		port: address.port,
		connections: () => count,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL through an HTTP CONNECT proxy (#5473)", () => {
	let directory: string;
	let ca: string;
	let frontCertificate: { cert: Buffer; key: Buffer };
	let front: { port: number; close(): Promise<void> };
	let proxy: ConnectProxy;
	/** Whether the front drops the server's answers, after a statement marked with {@link STALL_MARKER}. */
	let stalling = false;
	/** How many cancel requests reached the front, decrypted. */
	let cancelRequests = 0;

	beforeAll(async () => {
		directory = makeTempDirectory("atomic-pg-connect-proxy-");
		const certificate = writeCertificates(directory);
		ca = certificate.ca;
		frontCertificate = certificate;
		front = await startPostgresProxy(certificate, (client: Duplex, upstream: Duplex, first: Buffer) => {
			if (first.length >= 8 && first.readInt32BE(4) === CANCEL_REQUEST_CODE) cancelRequests++;
			let stalled = false;
			const fromClient = (chunk: Buffer) => {
				if (stalling && chunk.toString("latin1").includes(STALL_MARKER)) stalled = true;
				upstream.write(chunk);
			};
			fromClient(first);
			client.on("data", fromClient);
			upstream.on("data", (chunk: Buffer) => {
				if (!stalled) client.write(chunk);
			});
		});
		proxy = await startConnectProxy({
			routes: (target) =>
				target === `${DATABASE_HOST}:${PORT}` ||
				target === `${DATABASE_HOST}:${OTHER_PORT}` ||
				target === `${OTHER_HOST}:${PORT}`
					? { host: "127.0.0.1", port: front.port }
					: undefined,
		});
	});
	afterAll(async () => {
		await proxy?.close();
		await front?.close();
		removeTempDirectory(directory);
	});

	/** The URL of `database` on {@link DATABASE_HOST} (or `host`), verified against that name and the test CA. */
	function urlFor(database: string, host = DATABASE_HOST): string {
		const user = new URL(postgresTestUrl!).username;
		const url = new URL(`postgresql://${user}@${host}:${PORT}/${database}`);
		url.searchParams.set("sslmode", "verify-full");
		url.searchParams.set("sslrootcert", ca);
		return url.href;
	}

	function open(
		database: string,
		options: Partial<PostgresDatabaseOptions> & { host?: string } = {},
	): Promise<SqliteDatabase> {
		const { host, ...rest } = options;
		return openPostgresDatabase({
			url: urlFor(database, host),
			...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
			...rest,
		});
	}

	/**
	 * Every tunnel opened since `from` carries, from the client, an SSLRequest and then TLS records only, and from the
	 * server its `S` and then TLS records only: the proxy sees none of the session's plaintext either way.
	 */
	function assertCiphertextOnly(from: number): void {
		const opened = proxy.tunnels.slice(from);
		assert.ok(opened.length > 0, "no tunnel was opened");
		for (const tunnel of opened) {
			const sent = tunnel.clientBytes();
			const answered = tunnel.serverBytes();
			assert.ok(sent.length > 8, `the tunnel to ${tunnel.target} carried ${sent.length} bytes`);
			assert.equal(sent.readInt32BE(4), SSL_REQUEST_CODE, "the first message was not an SSLRequest");
			assert.equal(tlsRecordProblem(sent.subarray(8)), undefined, "the client sent something other than TLS");
			assert.equal(answered.subarray(0, 1).toString("latin1"), "S", "the server did not accept TLS");
			assert.equal(tlsRecordProblem(answered.subarray(1)), undefined, "the server sent something other than TLS");
			for (const plain of ["application_name", "atomic", "SELECT", "LISTEN", "pg_notify", "user\0"])
				for (const bytes of [sent, answered])
					assert.equal(
						bytes.includes(Buffer.from(plain)),
						false,
						`the proxy saw ${JSON.stringify(plain)} in clear`,
					);
		}
	}

	test("sessions and Intercom work through HTTPS_PROXY, with TLS verified end to end (#5473)", async () => {
		await withPostgresDatabase(async (scope) => {
			await withEnvironment({ HTTPS_PROXY: proxy.url }, async () => {
				const from = proxy.tunnels.length;
				const requestsBefore = proxy.requests.length;
				const opened: SqliteDatabase[] = [];
				const through = async () => {
					const database = await open(scope.name);
					opened.push(database);
					return database;
				};
				try {
					// Sessions.
					const timestamp = "2026-11-18T00:00:00.000Z";
					const store = await SqlSessionStore.open(await through());
					await store.create(
						{ id: "session", version: SESSION_FORMAT_VERSION, createdAt: timestamp, cwd: "/project" },
						[
							{
								type: "message",
								id: "first",
								parentId: null,
								timestamp,
								message: { role: "user", content: "through the tunnel", timestamp: Date.parse(timestamp) },
							},
						],
					);
					assert.equal((await (await SqlSessionStore.open(await through())).load("session")).entries.length, 1);

					// Intercom: a waiting host is woken by a notification its LISTEN session receives through the tunnel.
					const publisher = await openDatabaseWakeUpBus({
						openDatabase: through,
						prefix: "w5473_",
						pollIntervalMs: NEVER_POLL_MS,
					});
					const subscriber = await openDatabaseWakeUpBus({
						openDatabase: through,
						prefix: "w5473_",
						pollIntervalMs: NEVER_POLL_MS,
					});
					try {
						const hints: WakeUpHint[] = [];
						await subscriber.subscribe("broker-b", (event) => {
							if (event.kind === "hint") hints.push(event.hint);
						});
						await listening(scope);
						await publisher.publish({ brokerId: "broker-b", reason: "outbox", version: 1 });
						await until(() => hints.length > 0, NOTIFIED_WAKE_BOUND_MS, "the notification never arrived");
						assert.deepEqual(hints[0], { brokerId: "broker-b", reason: "outbox", version: 1 });
					} finally {
						await publisher.close();
						await subscriber.close();
					}
				} finally {
					await Promise.allSettled(opened.map((database) => database.close()));
				}
				// Every connection, the listening ones included, went through the proxy, and only to the database.
				const requests = proxy.requests.slice(requestsBefore);
				assert.ok(requests.length >= 2, inspect(requests));
				for (const request of requests) assert.equal(request.target, `${DATABASE_HOST}:${PORT}`);
				assertCiphertextOnly(from);
			});
		});
	});

	test("the listening session reconnects through the tunnel after the tunnel drops, and wake-ups resume (#5473)", async () => {
		await withPostgresDatabase(async (scope) => {
			await withEnvironment({ HTTPS_PROXY: proxy.url }, async () => {
				const opened: SqliteDatabase[] = [];
				const through = async () => {
					const database = await open(scope.name);
					opened.push(database);
					return database;
				};
				const publisher = await openDatabaseWakeUpBus({
					openDatabase: through,
					prefix: "r5473_",
					pollIntervalMs: NEVER_POLL_MS,
				});
				const subscriber = await openDatabaseWakeUpBus({
					openDatabase: through,
					prefix: "r5473_",
					pollIntervalMs: NEVER_POLL_MS,
				});
				try {
					const hints: WakeUpHint[] = [];
					await subscriber.subscribe("broker-b", (event) => {
						if (event.kind === "hint") hints.push(event.hint);
					});
					await listening(scope);
					const before = proxy.requests.length;
					const from = proxy.tunnels.length;
					proxy.dropTunnels();
					await until(
						() => proxy.requests.length > before,
						RELISTENING_BOUND_MS,
						"nothing reconnected through the proxy",
					);
					await listening(scope, RELISTENING_BOUND_MS);
					await publisher.publish({ brokerId: "broker-b", reason: "outbox", version: 2 });
					await until(() => hints.length > 0, NOTIFIED_WAKE_BOUND_MS, "no notification after the reconnect");
					for (const request of proxy.requests.slice(before))
						assert.equal(request.target, `${DATABASE_HOST}:${PORT}`);
					assertCiphertextOnly(from);
				} finally {
					await publisher.close();
					await subscriber.close();
					await Promise.allSettled(opened.map((database) => database.close()));
				}
			});
		});
	}, 60_000);

	test("wake-ups survive a proxy slower than the listening probe's wait, after every tunnel dropped (#5473)", async () => {
		const slow = await startConnectProxy({
			routes: (target) =>
				target === `${DATABASE_HOST}:${PORT}` ? { host: "127.0.0.1", port: front.port } : undefined,
			answerDelayMs: SLOW_PROXY_ANSWER_MS,
		});
		try {
			await withPostgresDatabase(async (scope) => {
				const opened: SqliteDatabase[] = [];
				const through = async () => {
					const database = await open(scope.name, { proxy: slow.url });
					opened.push(database);
					return database;
				};
				const publisher = await openDatabaseWakeUpBus({
					openDatabase: through,
					prefix: "s5473_",
					pollIntervalMs: NEVER_POLL_MS,
				});
				const subscriber = await openDatabaseWakeUpBus({
					openDatabase: through,
					prefix: "s5473_",
					pollIntervalMs: NEVER_POLL_MS,
				});
				try {
					const hints: WakeUpHint[] = [];
					await subscriber.subscribe("broker-b", (event) => {
						if (event.kind === "hint") hints.push(event.hint);
					});
					await listening(scope, SLOW_RELISTENING_BOUND_MS);
					// Every connection drops, the pool's idle ones too: the listening probe's notification then needs a new
					// pool connection, through the slow proxy, before it is sent.
					slow.dropTunnels();
					await new Promise((resolve) => setTimeout(resolve, 200));
					await listening(scope, SLOW_RELISTENING_BOUND_MS);
					await publisher.publish({ brokerId: "broker-b", reason: "outbox", version: 3 });
					await until(
						() => hints.length > 0,
						SLOW_PROXY_ANSWER_MS * 4,
						"no notification after the slow reconnect",
					);
				} finally {
					await publisher.close();
					await subscriber.close();
					await Promise.allSettled(opened.map((database) => database.close()));
				}
			});
		} finally {
			await slow.close();
		}
	}, 90_000);

	/** Waits until a session of the scope's database listens for wake-ups. */
	async function listening(scope: PostgresScope, boundMs = LISTENING_BOUND_MS): Promise<void> {
		await until(
			async () => {
				const row = await scope.admin.get<{ readonly listeners: number }>(
					"SELECT count(*)::int AS listeners FROM pg_stat_activity WHERE datname = ? AND application_name = 'atomic-listen' AND query LIKE 'LISTEN%'",
					scope.name,
				);
				return (row?.listeners ?? 0) > 0;
			},
			boundMs,
			"the bus never listened",
		);
	}

	test("the proxy option overrides the environment, and a socket factory replaces both (#5473)", async () => {
		await withPostgresDatabase(async (scope) => {
			await withEnvironment({ HTTPS_PROXY: `http://127.0.0.1:${await closedPort()}` }, async () => {
				const requestsBefore = proxy.requests.length;
				const viaOption = await open(scope.name, { proxy: proxy.url });
				try {
					assert.deepEqual(await viaOption.get("SELECT 1 AS one"), { one: 1 });
				} finally {
					await viaOption.close();
				}
				assert.ok(proxy.requests.length > requestsBefore);

				// A socket factory replaces the proxy, so even a proxy setting that could not be used does not matter.
				await withEnvironment({ HTTPS_PROXY: "socks5://agent:fixture%zz@127.0.0.1:1080" }, async () => {
					const targets: string[] = [];
					const viaSocket = await open(scope.name, {
						socket: ({ host, port }) => {
							targets.push(`${host}:${port}`);
							return connect(front.port, "127.0.0.1");
						},
					});
					try {
						assert.deepEqual(await viaSocket.get("SELECT 1 AS one"), { one: 1 });
					} finally {
						await viaSocket.close();
					}
					assert.ok(targets.length > 0);
					for (const target of targets) assert.equal(target, `${DATABASE_HOST}:${PORT}`);
					// A custom transport changes how the bytes travel, not whom TLS checks: a certificate for another name
					// is still refused.
					const wrong = await failure(
						open(scope.name, { host: OTHER_HOST, socket: () => connect(front.port, "127.0.0.1") }),
					);
					assert.ok(wrong instanceof StorageUnavailableError, inspect(wrong));
					assert.match(inspect(wrong), /ERR_TLS_CERT_ALTNAME_INVALID/);
				});
			});
		});
	});

	test("a URL without a host is decided, and encrypted, for PGHOST and PGPORT, the endpoint pg connects to (#5473)", async () => {
		await withPostgresDatabase(async (scope) => {
			const requestsBefore = proxy.requests.length;
			const from = proxy.tunnels.length;
			const url = new URL(urlFor(scope.name));
			url.searchParams.set("user", url.username);
			// No sslmode: PGHOST names a host other than this machine, so the default verify-full applies, as for a URL host.
			url.searchParams.delete("sslmode");
			const hostless = `postgresql:///${scope.name}${url.search}`;
			await withEnvironment(
				{ HTTPS_PROXY: proxy.url, PGHOST: DATABASE_HOST, PGPORT: String(OTHER_PORT) },
				async () => {
					const database = await openPostgresDatabase({
						url: hostless,
						...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
					});
					try {
						assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
						// The same default as a URL that names the host: TLS, with the certificate checked against it.
						assert.match(
							database.descriptor.location,
							/[?&]sslmode=verify-full(?:&|$)/,
							database.descriptor.location,
						);
					} finally {
						await database.close();
					}
				},
			);
			const requests = proxy.requests.slice(requestsBefore);
			assert.ok(requests.length > 0, "the connection did not go through the proxy");
			for (const request of requests) assert.equal(request.target, `${DATABASE_HOST}:${OTHER_PORT}`);
			assertCiphertextOnly(from);
		});
	});

	test.skipIf(MACHINE_ADDRESS === undefined)(
		"NO_PROXY for the database host connects directly, the listening session too, while the pool tunnels (#5473)",
		async () => {
			// The front, reached directly at this machine's own address, which is not loopback, so only NO_PROXY exempts it.
			const forwarder = await startForwarder(MACHINE_ADDRESS!, front.port);
			try {
				await withPostgresDatabase(async (scope) => {
					const user = new URL(postgresTestUrl!).username;
					const direct = new URL(`postgresql://${user}@${MACHINE_ADDRESS}:${forwarder.port}/${scope.name}`);
					// The front's certificate names db.invalid, not the address: check its CA only.
					direct.searchParams.set("sslmode", "verify-ca");
					direct.searchParams.set("sslrootcert", ca);
					const password = postgresTestPassword === undefined ? {} : { password: postgresTestPassword };
					await withEnvironment({ HTTPS_PROXY: proxy.url, NO_PROXY: `localhost,${MACHINE_ADDRESS}` }, async () => {
						const requestsBefore = proxy.requests.length;
						const database = await openPostgresDatabase({ url: direct.href, ...password });
						try {
							assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
						} finally {
							await database.close();
						}
						assert.equal(proxy.requests.length, requestsBefore, "an exempt host went through the proxy");
						assert.ok(forwarder.connections() > 0);

						// The pool through the tunnel, the listening session to the exempt endpoint, directly.
						const opened: SqliteDatabase[] = [];
						const split = async () => {
							const database = await open(scope.name, { listenUrl: direct.href });
							opened.push(database);
							return database;
						};
						const publisher = await openDatabaseWakeUpBus({
							openDatabase: split,
							prefix: "n5473_",
							pollIntervalMs: NEVER_POLL_MS,
						});
						const subscriber = await openDatabaseWakeUpBus({
							openDatabase: split,
							prefix: "n5473_",
							pollIntervalMs: NEVER_POLL_MS,
						});
						try {
							const hints: WakeUpHint[] = [];
							await subscriber.subscribe("broker-b", (event) => {
								if (event.kind === "hint") hints.push(event.hint);
							});
							await listening(scope);
							await publisher.publish({ brokerId: "broker-b", reason: "outbox", version: 4 });
							await until(() => hints.length > 0, NOTIFIED_WAKE_BOUND_MS, "the notification never arrived");
						} finally {
							await publisher.close();
							await subscriber.close();
							await Promise.allSettled(opened.map((database) => database.close()));
						}
						const requests = proxy.requests.slice(requestsBefore);
						assert.ok(requests.length > 0, "the pool did not go through the proxy");
						for (const request of requests) assert.equal(request.target, `${DATABASE_HOST}:${PORT}`);
					});
					// Without NO_PROXY, the same address goes to the proxy, whose allow-list refuses it.
					await withEnvironment({ HTTPS_PROXY: proxy.url }, async () => {
						const error = await failure(openPostgresDatabase({ url: direct.href, ...password }));
						assert.ok(error instanceof StorageUnavailableError, inspect(error));
						assert.ok(
							error.message.includes(
								`the proxy ${proxy.url} refused the tunnel to ${MACHINE_ADDRESS}:${forwarder.port} (403 Forbidden)`,
							),
							error.message,
						);
					});
				});
			} finally {
				await forwarder.close();
			}
		},
		60_000,
	);

	test.skipIf(!isLoopbackHost(postgresTestUrl === undefined ? "" : new URL(postgresTestUrl).hostname))(
		"a database on this machine is reached directly whatever the environment's proxy says (#5473)",
		async () => {
			await withEnvironment({ HTTPS_PROXY: proxy.url }, async () => {
				const requestsBefore = proxy.requests.length;
				const local = await openPostgresDatabase({
					url: postgresTestUrl!,
					...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
				});
				try {
					assert.deepEqual(await local.get("SELECT 1 AS one"), { one: 1 });
				} finally {
					await local.close();
				}
				assert.equal(proxy.requests.length, requestsBefore);
			});
		},
	);

	test("an https proxy whose certificate is not trusted is refused before any tunnel request (#5473)", async () => {
		const requests: Buffer[] = [];
		const secure = createTlsServer({ cert: frontCertificate.cert, key: frontCertificate.key }, (socket) => {
			socket.on("error", () => {});
			socket.on("data", (chunk: Buffer) => requests.push(chunk));
		});
		secure.on("tlsClientError", () => {});
		await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
		const address = secure.address();
		assert.ok(address !== null && typeof address === "object");
		try {
			const error = await failure(open("postgres", { proxy: `https://127.0.0.1:${address.port}` }));
			assert.ok(error instanceof StorageUnavailableError, inspect(error));
			assert.match(
				error.message,
				new RegExp(
					`the proxy https://127\\.0\\.0\\.1:${address.port} showed a TLS certificate that was not accepted \\(\\w+\\), so no tunnel to ${DATABASE_HOST}:${PORT} was opened`,
				),
			);
			assert.equal(requests.length, 0, "a tunnel request reached a proxy that was not trusted");
		} finally {
			await new Promise<void>((resolve) => secure.close(() => resolve()));
		}
	});

	test(
		"a proxy that refuses the tunnel fails the open with StorageUnavailableError naming the proxy and the target (#5473)",
		async () => {
			// An allow-list without the target: 403, not retried.
			await withEnvironment({ HTTPS_PROXY: proxy.url }, async () => {
				const requestsBefore = proxy.requests.length;
				const refused = await failure(open("postgres", { host: BLOCKED_HOST }));
				assert.ok(refused instanceof StorageUnavailableError, inspect(refused));
				assert.match(
					refused.message,
					new RegExp(`the proxy ${proxy.url} refused the tunnel to ${BLOCKED_HOST}:${PORT} \\(403 Forbidden\\)`),
				);
				assert.equal(proxy.requests.length, requestsBefore + 1, "a refused tunnel was asked for again");
			});
			// A proxy that wants credentials: 407, never naming the ones it was given.
			const guarded = await startConnectProxy({
				routes: () => ({ host: "127.0.0.1", port: front.port }),
				credentials: { user: "agent", password: "fixture-proxy-secret" },
			});
			try {
				const wrong = `http://agent:fixture-wrong-secret@127.0.0.1:${guarded.port}`;
				await withEnvironment({ HTTPS_PROXY: wrong }, async () => {
					const error = await failure(open("postgres"));
					assert.ok(error instanceof StorageUnavailableError, inspect(error));
					assert.match(
						error.message,
						new RegExp(
							`the proxy ${guarded.url} refused the tunnel to ${DATABASE_HOST}:${PORT} without accepted credentials \\(407`,
						),
					);
					assert.equal(inspect(error, { depth: null }).includes("fixture-wrong-secret"), false);
				});
				// The right credentials, from the proxy URL, open the tunnel.
				await withEnvironment(
					{ HTTPS_PROXY: `http://agent:fixture-proxy-secret@127.0.0.1:${guarded.port}` },
					async () => {
						const database = await open("postgres");
						try {
							assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
						} finally {
							await database.close();
						}
					},
				);
			} finally {
				await guarded.close();
			}
			// A proxy that is not there: retried as unreachable, then named with the target. Neither the failure nor the
			// warnings the retries print name the proxy's credentials.
			const port = await closedPort();
			await withEnvironment(
				{ HTTPS_PROXY: `http://agent:fixture-unreachable-secret@127.0.0.1:${port}` },
				async () => {
					const warnings: string[] = [];
					const onWarning = (warning: Error) => warnings.push(inspect(warning, { depth: null }));
					process.on("warning", onWarning);
					try {
						const error = await failure(open("postgres"));
						assert.ok(error instanceof StorageUnavailableError, inspect(error));
						assert.ok(
							error.message.includes(
								`the proxy http://127.0.0.1:${port} could not be reached for the tunnel to ${DATABASE_HOST}:${PORT} (ECONNREFUSED)`,
							),
							error.message,
						);
						assert.equal(inspect(error, { depth: null }).includes("fixture-unreachable-secret"), false);
					} finally {
						process.off("warning", onWarning);
					}
					for (const warning of warnings)
						assert.equal(warning.includes("fixture-unreachable-secret"), false, warning);
				},
			);
		},
		TRANSIENT_RETRIES_TIMEOUT_MS,
	);

	test("through the tunnel, a certificate for another host name is refused (#5473)", async () => {
		await withEnvironment({ HTTPS_PROXY: proxy.url }, async () => {
			const error = await failure(open("postgres", { host: OTHER_HOST }));
			assert.ok(error instanceof StorageUnavailableError, inspect(error));
			assert.match(inspect(error), /ERR_TLS_CERT_ALTNAME_INVALID/);
			assert.match(inspect(error), /TLS certificate was not accepted/);
		});
	});

	test(
		"a statement the client gives up on is cancelled through the tunnel, over TLS (#5473)",
		async () => {
			await withPostgresDatabase(async (scope) => {
				await withEnvironment({ HTTPS_PROXY: proxy.url }, async () => {
					const database = await open(scope.name, { statementTimeoutMs: CANCEL_STATEMENT_TIMEOUT_MS });
					stalling = true;
					try {
						assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
						const from = proxy.tunnels.length;
						// The server answers nothing the client can read: it gives up and asks the server to cancel.
						const cancelsBefore = cancelRequests;
						const error = await failure(database.get(`SELECT pg_sleep(30) ${STALL_MARKER}`));
						assert.ok(error instanceof StorageUnavailableError, inspect(error));
						// The cancel request reached the server's side of the tunnel inside TLS.
						await until(() => cancelRequests > cancelsBefore, 5_000, "no cancel request arrived");
						// The cancel request went through the proxy, after an SSLRequest, encrypted: its key never in clear.
						const cancelCode = Buffer.alloc(4);
						cancelCode.writeInt32BE(CANCEL_REQUEST_CODE, 0);
						const tunnels = proxy.tunnels.slice(from);
						assert.ok(tunnels.length > 0, "the cancel request did not go through the proxy");
						for (const tunnel of tunnels) assert.equal(tunnel.clientBytes().includes(cancelCode), false);
						assertCiphertextOnly(from);
					} finally {
						stalling = false;
						await database.close();
					}
				});
			});
		},
		CANCEL_TEST_TIMEOUT_MS,
	);

	test(
		"a cancel request whose tunnel the server side never answers is closed when the client gives up on it (#5473)",
		async () => {
			let blackHole = false;
			const holding = await startConnectProxy({
				routes: (target) =>
					target === `${DATABASE_HOST}:${PORT}` ? { host: "127.0.0.1", port: front.port } : undefined,
				blackHole: () => blackHole,
			});
			try {
				await withPostgresDatabase(async (scope) => {
					const database = await open(scope.name, {
						statementTimeoutMs: CANCEL_STATEMENT_TIMEOUT_MS,
						proxy: holding.url,
					});
					stalling = true;
					try {
						assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
						// A hung server: the proxy still opens the cancel request's tunnel, and nothing answers there.
						blackHole = true;
						const from = holding.tunnels.length;
						await failure(database.get(`SELECT pg_sleep(30) ${STALL_MARKER}`));
						const cancels = holding.tunnels.slice(from);
						assert.ok(cancels.length > 0, "no cancel request was sent");
						await until(
							() => cancels.every((tunnel) => tunnel.clientClosed()),
							2_000,
							"the cancel request's tunnel was left open after the client gave up on it",
						);
					} finally {
						stalling = false;
						blackHole = false;
						await database.close();
					}
				});
			} finally {
				await holding.close();
			}
		},
		CANCEL_TEST_TIMEOUT_MS,
	);
});

/** Polls `condition` until it holds, or fails with `message` after `boundMs`. */
async function until(condition: () => boolean | Promise<boolean>, boundMs: number, message: string): Promise<void> {
	const deadline = Date.now() + boundMs;
	for (;;) {
		if (await condition()) return;
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
