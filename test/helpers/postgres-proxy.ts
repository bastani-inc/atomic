import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { connect as connectTls, TLSSocket } from "node:tls";
import { postgresTestUrl } from "./postgres-database.js";
import { spawnSyncCollect, writeTextSync } from "./runtime.js";

/**
 * Test proxies in front of the PostgreSQL test server (#5218). A managed server such as Azure takes TLS only, so a proxy
 * that inspects or holds the protocol terminates the client's TLS with a throwaway certificate for 127.0.0.1 and opens
 * TLS of its own to the server, as libpq would: an SSLRequest, then a handshake that checks the server's certificate
 * against the host name and `sslrootcert` of `ATOMIC_TEST_POSTGRES_URL` (Node's CAs without one). A local server
 * without TLS is reached in plaintext, as before.
 */

/** The protocol's SSLRequest code, which a client sends before its TLS handshake. */
export const SSL_REQUEST_CODE = 80877103;
/** The protocol's CancelRequest code: sent on a connection of its own, unencrypted, and passed on as it is. */
export const CANCEL_REQUEST_CODE = 80877102;

const target = () => new URL(postgresTestUrl!);

/** Whether the test server is reached over TLS: its URL asks for `require`, `verify-ca` or `verify-full`. */
export function postgresTestUsesTls(): boolean {
	const mode = target().searchParams.get("sslmode");
	return mode === "require" || mode === "verify-ca" || mode === "verify-full";
}

/** A plain TCP connection to the test server's address. */
export function connectTestServerPlain(): Socket {
	const url = target();
	return connect(Number(url.port || 5432), url.hostname);
}

/** Reads the one byte a server answers an SSLRequest with. */
function readSslAnswer(socket: Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.once("data", (chunk: Buffer) => {
			socket.off("error", reject);
			// Nothing else may arrive before the handshake; a server that sent more is not one to talk to.
			assert.equal(chunk.length, 1, "the server answered the SSLRequest with more than one byte");
			resolve(chunk.toString("latin1"));
		});
	});
}

/**
 * A connection to the test server, encrypted as its URL asks: after an SSLRequest the server must answer `S`, and its
 * certificate must match the URL's host name, or with `verify-ca` only its `sslrootcert` CA.
 */
export async function connectTestServer(): Promise<Duplex> {
	const raw = connectTestServerPlain();
	if (!postgresTestUsesTls()) return raw;
	await once(raw, "connect");
	const request = Buffer.alloc(8);
	request.writeInt32BE(8, 0);
	request.writeInt32BE(SSL_REQUEST_CODE, 4);
	raw.write(request);
	assert.equal(await readSslAnswer(raw), "S", "the test server refused TLS");
	const url = target();
	const caFile = url.searchParams.get("sslrootcert");
	const mode = url.searchParams.get("sslmode");
	const secure = connectTls({
		socket: raw,
		servername: url.hostname,
		...(caFile === null ? {} : { ca: readFileSync(caFile) }),
		...(mode === "verify-ca" ? { checkServerIdentity: () => undefined } : {}),
		...(mode === "require" && caFile === null ? { rejectUnauthorized: false } : {}),
	});
	await once(secure, "secureConnect");
	return secure;
}

function openssl(directory: string, ...args: string[]): void {
	const result = spawnSyncCollect(["openssl", ...args], { cwd: directory });
	assert.equal(result.exitCode, 0, result.stderr.toString());
}

/** A throwaway CA and a certificate it signed for 127.0.0.1, written to `directory`. */
export function writeProxyCertificates(directory: string): { ca: string; cert: Buffer; key: Buffer } {
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
		"/CN=Atomic proxy CA",
		"-keyout",
		"proxy-ca.key",
		"-out",
		"proxy-ca.pem",
	);
	openssl(
		directory,
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-subj",
		"/CN=127.0.0.1",
		"-keyout",
		"proxy.key",
		"-out",
		"proxy.csr",
	);
	writeTextSync(join(directory, "proxy.ext"), "subjectAltName=IP:127.0.0.1\n");
	openssl(
		directory,
		"x509",
		"-req",
		"-in",
		"proxy.csr",
		"-CA",
		"proxy-ca.pem",
		"-CAkey",
		"proxy-ca.key",
		"-CAcreateserial",
		"-days",
		"2",
		"-extfile",
		"proxy.ext",
		"-out",
		"proxy.pem",
	);
	return {
		ca: join(directory, "proxy-ca.pem"),
		cert: readFileSync(join(directory, "proxy.pem")),
		key: readFileSync(join(directory, "proxy.key")),
	};
}

/** The test URL `url` pointed at a proxy on 127.0.0.1:`port`, which checks the proxy's certificate when TLS is used. */
export function proxiedUrl(url: string, port: number, ca: string | undefined): string {
	const proxied = new URL(url);
	proxied.host = `127.0.0.1:${port}`;
	for (const name of [...proxied.searchParams.keys()]) if (name.startsWith("ssl")) proxied.searchParams.delete(name);
	if (ca !== undefined && postgresTestUsesTls()) {
		proxied.searchParams.set("sslmode", "verify-full");
		proxied.searchParams.set("sslrootcert", ca);
	}
	return proxied.href;
}

/**
 * Accepts connections on 127.0.0.1 and calls `serve` with each client's protocol stream, decrypted when the client asked
 * for TLS (with `certificate`), and the connection to the test server it should talk to. A CancelRequest is passed on
 * to the server unencrypted, as a client sends it, and never reaches `serve`.
 */
export async function startPostgresProxy(
	certificate: { cert: Buffer; key: Buffer } | undefined,
	serve: (client: Duplex, upstream: Duplex, first: Buffer) => void,
): Promise<{ port: number; close(): Promise<void> }> {
	const sockets = new Set<Duplex>();
	const track = (socket: Duplex) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		return socket;
	};
	const server = createServer((client) => {
		track(client);
		client.once("data", (first: Buffer) => {
			const code = first.length >= 8 ? first.readInt32BE(4) : 0;
			if (code === CANCEL_REQUEST_CODE) {
				const upstream = track(connectTestServerPlain());
				upstream.write(first);
				upstream.pipe(client).pipe(upstream);
				return;
			}
			if (code === SSL_REQUEST_CODE) {
				if (certificate === undefined) {
					client.write("N");
					client.once("data", (startup: Buffer) => void plain(client, startup));
					return;
				}
				client.write("S");
				const secure = track(
					new TLSSocket(client, { isServer: true, cert: certificate.cert, key: certificate.key }),
				);
				secure.once("data", (startup: Buffer) => void plain(secure, startup));
				return;
			}
			void plain(client, first);
		});
	});
	const plain = async (client: Duplex, first: Buffer) => {
		client.pause();
		let upstream: Duplex;
		try {
			upstream = track(await connectTestServer());
		} catch {
			client.destroy();
			return;
		}
		for (const socket of [client, upstream])
			socket.on("close", () => {
				client.destroy();
				upstream.destroy();
			});
		serve(client, upstream, first);
		client.resume();
	};
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
