import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { inspect } from "node:util";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { afterAll, beforeAll, describe, test } from "vitest";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { postgresSkipReason, postgresTestPassword, postgresTestUrl } from "../helpers/postgres-database.js";
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
	const target = new URL(postgresTestUrl!);
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
				const upstream = connect(Number(target.port || 5432), target.hostname);
				sockets.add(upstream);
				upstream.on("error", () => secure.destroy());
				secure.pipe(upstream).pipe(secure);
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
