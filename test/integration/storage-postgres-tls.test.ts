import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createServer as createTlsServer, getCACertificates, setDefaultCACertificates, TLSSocket } from "node:tls";
import { inspect } from "node:util";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { afterAll, beforeAll, describe, test } from "vitest";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { startConnectProxy } from "../helpers/http-connect-proxy.js";
import { postgresSkipReason, postgresTestPassword, postgresTestUrl } from "../helpers/postgres-database.js";
import { connectTestServer } from "../helpers/postgres-proxy.js";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect, writeTextSync } from "../helpers/runtime.js";

/** The only name in the server certificate: the address the tests connect to, 127.0.0.1, is not among its names. */
const CERTIFICATE_NAME = "db.invalid";
/** The protocol's SSLRequest code, which a client sends before its TLS handshake. */
const SSL_REQUEST_CODE = 80877103;

function openssl(directory: string, ...args: string[]): void {
	const result = spawnSyncCollect(["openssl", ...args], { cwd: directory });
	assert.equal(result.exitCode, 0, result.stderr.toString());
}

/** A CA, a second CA that signed nothing the server shows, and a server certificate the first CA signed. */
function writeCertificates(directory: string): void {
	for (const ca of ["ca", "other-ca"])
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
			`/CN=Atomic test ${ca}`,
			"-keyout",
			`${ca}.key`,
			"-out",
			`${ca}.pem`,
		);
	openssl(
		directory,
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-subj",
		`/CN=${CERTIFICATE_NAME}`,
		"-keyout",
		"server.key",
		"-out",
		"server.csr",
	);
	writeTextSync(join(directory, "server.ext"), `subjectAltName=DNS:${CERTIFICATE_NAME}\n`);
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
}

/**
 * A server that speaks TLS as PostgreSQL does, with a certificate for {@link CERTIFICATE_NAME}, and passes each
 * connection on, decrypted, to the test server.
 */
async function startTlsServer(directory: string): Promise<{ port: number; close(): Promise<void> }> {
	const cert = readFileSync(join(directory, "server.pem"));
	const key = readFileSync(join(directory, "server.key"));
	const sockets = new Set<Socket>();
	const server = createServer((client) => {
		sockets.add(client);
		client.on("error", () => {});
		client.once("data", (request: Buffer) => {
			assert.equal(request.readInt32BE(4), SSL_REQUEST_CODE);
			client.write("S");
			const secure = new TLSSocket(client, { isServer: true, cert, key });
			secure.on("error", () => client.destroy());
			secure.once("secure", () => {
				// The test server, over TLS when it takes TLS only (#5218); the client's startup waits in `secure` meanwhile.
				secure.pause();
				connectTestServer().then(
					(upstream) => {
						sockets.add(upstream as Socket);
						upstream.on("error", () => secure.destroy());
						secure.pipe(upstream).pipe(secure);
						secure.resume();
					},
					() => secure.destroy(),
				);
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

/** The codes along `error`'s cause chain. */
function causeCodes(error: Error | object | undefined): string[] {
	const codes: string[] = [];
	for (let current = error; current instanceof Error; current = current.cause as Error | undefined) {
		const code = (current as Error & { readonly code?: string | number }).code;
		if (typeof code === "string") codes.push(code);
	}
	return codes;
}

describe.skipIf(postgresSkipReason !== undefined)("Postgres sslmode (#5113)", () => {
	let directory: string;
	let tls: { port: number; close(): Promise<void> };

	beforeAll(async () => {
		directory = makeTempDirectory("atomic-pg-tls-");
		writeCertificates(directory);
		tls = await startTlsServer(directory);
	});
	afterAll(async () => {
		await tls?.close();
		removeTempDirectory(directory);
	});

	/** Opens the test server through the TLS server with `query` added to the URL. */
	function open(query: Record<string, string>): Promise<SqliteDatabase> {
		const target = new URL(postgresTestUrl!);
		const url = new URL(`postgresql://127.0.0.1:${tls.port}${target.pathname}`);
		url.username = target.username;
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return openPostgresDatabase({
			url: url.href,
			...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
		});
	}

	async function assertConnects(query: Record<string, string>): Promise<void> {
		const database = await open(query);
		try {
			assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
		} finally {
			await database.close();
		}
	}

	async function assertRefused(query: Record<string, string>, code: string): Promise<void> {
		await assert.rejects(
			async () => {
				const database = await open(query);
				try {
					await database.get("SELECT 1 AS one");
				} finally {
					await database.close();
				}
			},
			(error: Error) => {
				assert.ok(causeCodes(error).includes(code), inspect(error));
				// A certificate refused is permanent, never retried as unreachable, and says what to fix (#5218).
				assert.equal(error.name, "StorageUnavailableError", inspect(error));
				assert.match(inspect(error), /TLS certificate was not accepted/);
				assert.match(inspect(error), /sslrootcert/);
				return true;
			},
		);
	}

	test("sslmode=verify-ca checks the certificate's CA but not its host name, with no extra parameter (#5113)", async () => {
		await assertConnects({ sslmode: "verify-ca", sslrootcert: join(directory, "ca.pem") });
		await assertRefused(
			{ sslmode: "verify-ca", sslrootcert: join(directory, "other-ca.pem") },
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		);
	});

	test("sslmode=verify-full checks the host name (#5113)", async () => {
		await assertRefused(
			{ sslmode: "verify-full", sslrootcert: join(directory, "ca.pem") },
			"ERR_TLS_CERT_ALTNAME_INVALID",
		);
	});

	test("sslmode=require with sslrootcert checks the CA but not the host name, as libpq does; without it, the certificate is checked (#5113)", async () => {
		await assertConnects({ sslmode: "require", sslrootcert: join(directory, "ca.pem") });
		await assertRefused(
			{ sslmode: "require", sslrootcert: join(directory, "other-ca.pem") },
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		);
		await assertRefused({ sslmode: "require" }, "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
	});

	test("sslmode=prefer and allow encrypt without checking the certificate, as libpq does (#5113)", async () => {
		for (const sslmode of ["prefer", "allow"]) await assertConnects({ sslmode });
	});

	test("an explicit uselibpqcompat keeps pg's own reading of sslmode (#5113)", async () => {
		await assertConnects({ sslmode: "require", uselibpqcompat: "true" });
	});
});

/** The host name the refused chains' server certificates carry, which only a proxy can reach. */
const REFUSED_HOST = "db.invalid";

/**
 * Roots TLS verification will not anchor a server certificate to, and the code it reports for each (#6074): one that is
 * not a CA, one limited to client authentication, and one whose path length an intermediate CA exceeds.
 */
const REFUSED_ROOTS: readonly {
	readonly name: string;
	readonly extensions: readonly string[];
	readonly intermediate: boolean;
	readonly code: string;
}[] = [
	{
		name: "a root that is not a CA",
		extensions: ["basicConstraints=critical,CA:FALSE"],
		intermediate: false,
		code: "INVALID_PURPOSE",
	},
	{
		name: "a root limited to client authentication",
		extensions: [
			"basicConstraints=critical,CA:TRUE",
			"keyUsage=critical,keyCertSign,cRLSign",
			"extendedKeyUsage=clientAuth",
		],
		intermediate: false,
		code: "INVALID_PURPOSE",
	},
	{
		name: "a root whose path length the chain exceeds",
		extensions: ["basicConstraints=critical,CA:TRUE,pathlen:0", "keyUsage=critical,keyCertSign,cRLSign"],
		intermediate: true,
		code: "PATH_LENGTH_EXCEEDED",
	},
];

/**
 * Writes a root with `extensions` and a server certificate for {@link REFUSED_HOST} and 127.0.0.1 under it, through an
 * intermediate CA when `intermediate`; returns the root's file and the chain a server shows.
 */
function writeRefusedChain(
	directory: string,
	prefix: string,
	extensions: readonly string[],
	intermediate: boolean,
): { root: string; cert: Buffer; key: Buffer } {
	writeTextSync(
		join(directory, `${prefix}-root.cnf`),
		`[req]\ndistinguished_name = dn\n[dn]\n[root]\n${extensions.join("\n")}\n`,
	);
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
		`/CN=Atomic test ${prefix} root`,
		"-config",
		`${prefix}-root.cnf`,
		"-extensions",
		"root",
		"-keyout",
		`${prefix}-root.key`,
		"-out",
		`${prefix}-root.pem`,
	);
	/** Signs a new certificate for `subject` with `issuer`'s key. */
	const sign = (name: string, subject: string, issuer: string, lines: readonly string[]) => {
		openssl(
			directory,
			"req",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-subj",
			subject,
			"-keyout",
			`${name}.key`,
			"-out",
			`${name}.csr`,
		);
		writeTextSync(join(directory, `${name}.ext`), `${lines.join("\n")}\n`);
		openssl(
			directory,
			"x509",
			"-req",
			"-in",
			`${name}.csr`,
			"-CA",
			`${issuer}.pem`,
			"-CAkey",
			`${issuer}.key`,
			"-CAcreateserial",
			"-days",
			"2",
			"-extfile",
			`${name}.ext`,
			"-out",
			`${name}.pem`,
		);
	};
	let issuer = `${prefix}-root`;
	if (intermediate) {
		sign(`${prefix}-intermediate`, `/CN=Atomic test ${prefix} intermediate`, issuer, [
			"basicConstraints=critical,CA:TRUE",
			"keyUsage=critical,keyCertSign,cRLSign",
		]);
		issuer = `${prefix}-intermediate`;
	}
	sign(`${prefix}-server`, `/CN=${REFUSED_HOST}`, issuer, [
		`subjectAltName=DNS:${REFUSED_HOST},IP:127.0.0.1`,
		"extendedKeyUsage=serverAuth",
	]);
	const server = readFileSync(join(directory, `${prefix}-server.pem`));
	return {
		root: join(directory, `${prefix}-root.pem`),
		cert: intermediate
			? Buffer.concat([server, readFileSync(join(directory, `${prefix}-intermediate.pem`))])
			: server,
		key: readFileSync(join(directory, `${prefix}-server.key`)),
	};
}

/**
 * A server that answers an SSLRequest as PostgreSQL does and shows `chain` in the TLS handshake that follows; it counts
 * the SSLRequests, one per connection attempt.
 */
async function startRefusedFront(chain: {
	cert: Buffer;
	key: Buffer;
}): Promise<{ port: number; attempts(): number; close(): Promise<void> }> {
	let attempts = 0;
	const sockets = new Set<Socket>();
	const server = createServer((client) => {
		sockets.add(client);
		client.on("error", () => {});
		client.once("data", (request: Buffer) => {
			assert.equal(request.readInt32BE(4), SSL_REQUEST_CODE);
			attempts++;
			client.write("S");
			const secure = new TLSSocket(client, { isServer: true, cert: chain.cert, key: chain.key });
			secure.on("error", () => client.destroy());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		port: address.port,
		attempts: () => attempts,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

/** The error opening `url` and running a statement failed with. */
async function openFailure(url: string, proxy?: string): Promise<Error> {
	const outcome = await openPostgresDatabase({
		url,
		password: "fixture-password",
		...(proxy === undefined ? {} : { proxy }),
	}).then(
		async (database) => {
			try {
				await database.get("SELECT 1 AS one");
			} finally {
				await database.close();
			}
		},
		(error: Error) => error,
	);
	assert.ok(outcome instanceof Error, "the database opened");
	return outcome;
}

// No PostgreSQL server is reached: the handshake fails first. The tests run with the other TLS tests, where openssl,
// which writes the certificates, is present.
describe.skipIf(postgresSkipReason !== undefined)("A refused certificate authority (#6074)", () => {
	let directory: string;

	beforeAll(() => {
		directory = makeTempDirectory("atomic-pg-tls-refused-");
	});
	afterAll(() => {
		removeTempDirectory(directory);
	});

	for (const [index, refused] of REFUSED_ROOTS.entries()) {
		test(`a server certificate under ${refused.name} fails at once with ${refused.code} and the sslrootcert fix, directly and through a proxy (#6074)`, async () => {
			const chain = writeRefusedChain(directory, `refused-${index}`, refused.extensions, refused.intermediate);
			const front = await startRefusedFront(chain);
			const proxy = await startConnectProxy({
				routes: (target) =>
					target === `${REFUSED_HOST}:5432` ? { host: "127.0.0.1", port: front.port } : undefined,
			});
			const query = `sslmode=verify-ca&sslrootcert=${encodeURIComponent(chain.root)}`;
			try {
				for (const [route, opening] of [
					["directly", () => openFailure(`postgresql://atomic@127.0.0.1:${front.port}/atomic?${query}`)],
					[
						"through a proxy",
						() => openFailure(`postgresql://atomic@${REFUSED_HOST}:5432/atomic?${query}`, proxy.url),
					],
				] as const) {
					const before = front.attempts();
					const error = await opening();
					const shown = inspect(error, { depth: null });
					assert.equal(error.name, "StorageUnavailableError", `${route}: ${shown}`);
					assert.ok(causeCodes(error).includes(refused.code), `${route}: ${shown}`);
					assert.ok(
						shown.includes(`The server's TLS certificate was not accepted (${refused.code}: `),
						`${route}: ${shown}`,
					);
					assert.ok(
						shown.includes("Add sslrootcert=<CA file> with the server's CA to the URL"),
						`${route}: ${shown}`,
					);
					assert.equal(front.attempts() - before, 1, `${route}: the refused certificate was asked for again`);
				}
				assert.equal(proxy.requests.length, 1, "the tunnel was asked for again");
			} finally {
				await proxy.close();
				await front.close();
			}
		});
	}

	test("an https proxy whose certificate is under a root that is not a CA is refused at once, naming the code (#6074)", async () => {
		const chain = writeRefusedChain(directory, "refused-proxy", ["basicConstraints=critical,CA:FALSE"], false);
		let connections = 0;
		const requests: Buffer[] = [];
		const secure = createTlsServer({ cert: chain.cert, key: chain.key }, (socket) => {
			socket.on("error", () => {});
			socket.on("data", (chunk: Buffer) => requests.push(chunk));
		});
		secure.on("connection", () => connections++);
		secure.on("tlsClientError", () => {});
		await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
		const address = secure.address();
		assert.ok(address !== null && typeof address === "object");
		// The proxy's certificate is checked against the CAs Node trusts: here, with the refused root among them.
		const trusted = getCACertificates("default");
		setDefaultCACertificates([...trusted, readFileSync(chain.root, "utf8")]);
		try {
			const error = await openFailure(
				`postgresql://atomic@${REFUSED_HOST}:5432/atomic?sslmode=verify-ca&sslrootcert=${encodeURIComponent(chain.root)}`,
				`https://127.0.0.1:${address.port}`,
			);
			assert.equal(error.name, "StorageUnavailableError", inspect(error, { depth: null }));
			assert.ok(
				error.message.includes(
					`the proxy https://127.0.0.1:${address.port} showed a TLS certificate that was not accepted (INVALID_PURPOSE), so no tunnel to ${REFUSED_HOST}:5432 was opened`,
				),
				error.message,
			);
			assert.equal(connections, 1, "the proxy was connected to again");
			assert.equal(requests.length, 0, "a tunnel request reached a proxy that was not trusted");
		} finally {
			setDefaultCACertificates(trusted);
			await new Promise<void>((resolve) => secure.close(() => resolve()));
		}
	});
});
