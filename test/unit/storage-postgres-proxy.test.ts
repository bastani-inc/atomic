import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { buffer } from "node:stream/consumers";
import { describe, test } from "vitest";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import {
	authorityOf,
	noProxyMatches,
	openProxyTunnel,
	ProxySettingError,
	ProxyTunnelError,
	parseProxy,
	postgresTransport,
	proxySetting,
} from "../../packages/storage-postgres/proxy.js";
import { closedPort } from "../helpers/http-connect-proxy.js";

/**
 * Which proxy a PostgreSQL connection uses, and the tunnel it asks the proxy for (#5473). The adapter's integration
 * tests run a real server through a real proxy; these cover the decisions and the proxy's answers one by one.
 */

/** A loopback server that answers each connection with `answer`, given the request it received. */
async function fakeProxy(answer: (socket: Socket, request: string) => void): Promise<{
	server: Server;
	port: number;
	requests: string[];
}> {
	const requests: string[] = [];
	const server = createServer((socket) => {
		let received = "";
		socket.on("error", () => {});
		socket.on("data", (chunk: Buffer) => {
			received += chunk.toString("latin1");
			if (!received.includes("\r\n\r\n")) return;
			requests.push(received);
			answer(socket, received);
			received = "";
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return { server, port: address.port, requests };
}

function proxyAt(port: number, credentials = "") {
	return parseProxy(`http://${credentials}127.0.0.1:${port}`, "HTTPS_PROXY");
}

async function tunnelFailure(promise: Promise<unknown>): Promise<ProxyTunnelError> {
	const error = await promise.then(
		() => undefined,
		(caught: Error) => caught,
	);
	assert.ok(error instanceof ProxyTunnelError, String(error));
	return error;
}

describe("PostgreSQL proxy selection (#5473)", () => {
	const target = { host: "db.example.com", port: 5432 };

	test("HTTPS_PROXY applies to a remote database; NO_PROXY, a loopback host and a socket directory go direct (#5473)", () => {
		const env = { HTTPS_PROXY: "http://proxy.local:3128" };
		const proxied = postgresTransport(target, env);
		assert.equal(proxied.kind, "proxy");
		assert.equal(proxied.kind === "proxy" && proxied.proxy.label, "http://proxy.local:3128");
		assert.equal(postgresTransport(target, { ...env, NO_PROXY: "example.com" }).kind, "direct");
		assert.equal(postgresTransport(target, { ...env, no_proxy: "db.example.com:5432" }).kind, "direct");
		assert.equal(postgresTransport(target, { ...env, NO_PROXY: "db.example.com:6543" }).kind, "proxy");
		// The host is matched in its canonical form, as a URL's host is.
		for (const [host, noProxy] of [
			["10.1", "10.0.0.1"],
			["167772161", "10.0.0.1"],
			["2001:DB8:0:0::5", "2001:db8::5"],
			["bücher.example", "xn--bcher-kva.example"],
		])
			assert.equal(
				postgresTransport({ host: host!, port: 5432 }, { ...env, NO_PROXY: noProxy }).kind,
				"direct",
				host,
			);
		for (const host of [
			"localhost",
			"LOCALHOST",
			"localhost.",
			"127.0.0.1",
			"127.0.0.2",
			"::1",
			"[::1]",
			"/var/run/postgresql",
			"127.1",
			"0:0:0:0:0:0:0:1",
			"::ffff:127.0.0.1",
			"[::ffff:127.0.0.1]",
		])
			assert.equal(postgresTransport({ host, port: 5432 }, env).kind, "direct", host);
		for (const host of ["128.0.0.1", "::ffff:10.0.0.1", "::2", "localhost.example.com", "10.0.0.1"])
			assert.equal(postgresTransport({ host, port: 5432 }, env).kind, "proxy", host);
	});

	test("the environment's variables are read as Atomic's HTTPS clients read them, with ALL_PROXY between (#5473)", () => {
		assert.equal(proxySetting({}), undefined);
		assert.deepEqual(proxySetting({ HTTPS_PROXY: "http://a:1" }), { variable: "HTTPS_PROXY", value: "http://a:1" });
		// The lowercase form wins, even empty, which then sets nothing and the next variable is read.
		assert.deepEqual(proxySetting({ https_proxy: "http://b:1", HTTPS_PROXY: "http://a:1" }), {
			variable: "https_proxy",
			value: "http://b:1",
		});
		assert.deepEqual(proxySetting({ https_proxy: "", HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://c:1" }), {
			variable: "HTTP_PROXY",
			value: "http://c:1",
		});
		assert.deepEqual(proxySetting({ ALL_PROXY: "http://d:1", HTTP_PROXY: "http://c:1" }), {
			variable: "ALL_PROXY",
			value: "http://d:1",
		});
		// A SOCKS ALL_PROXY, meant for other tools, is passed over.
		assert.deepEqual(proxySetting({ ALL_PROXY: "socks5://d:1", HTTP_PROXY: "http://c:1" }), {
			variable: "HTTP_PROXY",
			value: "http://c:1",
		});
		assert.equal(proxySetting({ ALL_PROXY: "socks5h://d:1" }), undefined);
	});

	test("NO_PROXY matches hosts, subdomains, wildcards and ports as Atomic's HTTPS clients do (#5473)", () => {
		assert.equal(noProxyMatches("db.example.com", 5432, ""), false);
		assert.equal(noProxyMatches("db.example.com", 5432, "*"), true);
		assert.equal(noProxyMatches("db.example.com", 5432, " other.test , * "), true);
		assert.equal(noProxyMatches("db.example.com", 5432, "*:6543"), false);
		assert.equal(noProxyMatches("db.example.com", 5432, ".example.com"), true);
		assert.equal(noProxyMatches("example.com", 5432, ".example.com"), true);
		assert.equal(noProxyMatches("example.com", 5432, "*.example.com"), false);
		assert.equal(noProxyMatches("db.example.com", 5432, "*.example.com"), true);
		assert.equal(noProxyMatches("notexample.com", 5432, "example.com"), false);
		assert.equal(noProxyMatches("DB.Example.COM.", 5432, "db.example.com"), true);
		assert.equal(noProxyMatches("::1", 5432, "[::1]:5432"), true);
		assert.equal(noProxyMatches("::1", 5432, "::1"), true);
	});

	test("the proxy option overrides the environment: none, or a URL used even for this machine (#5473)", () => {
		const env = { HTTPS_PROXY: "http://proxy.local:3128" };
		assert.equal(postgresTransport(target, env, "none").kind, "direct");
		assert.equal(postgresTransport(target, env, " NONE ").kind, "direct");
		const local = postgresTransport({ host: "127.0.0.1", port: 5432 }, {}, "http://127.0.0.1:9");
		assert.equal(local.kind, "proxy");
		const option = postgresTransport(target, { ...env, NO_PROXY: "*" }, "proxy.other:8080");
		assert.equal(option.kind === "proxy" && option.proxy.label, "http://proxy.other:8080");
	});

	test("a proxy URL's credentials are sent as Basic and never named; unusable settings name their source only (#5473)", () => {
		const proxy = parseProxy("http://agent%40corp:p%3Ass@proxy.local:3128", "HTTPS_PROXY");
		assert.equal(proxy.label, "http://proxy.local:3128");
		assert.equal(proxy.authorization, `Basic ${Buffer.from("agent@corp:p:ss").toString("base64")}`);
		assert.equal(parseProxy("https://proxy.local", "x").port, 443);
		assert.equal(parseProxy("proxy.local", "x").port, 80);
		for (const value of [
			"socks5://user:fixture-secret@proxy.local:1080",
			"http://user:fixture%zzsecret@proxy.local:1",
			"http://",
		]) {
			assert.throws(
				() => parseProxy(value, "HTTPS_PROXY"),
				(error: Error) => {
					assert.ok(error instanceof ProxySettingError, String(error));
					assert.match(error.message, /^HTTPS_PROXY /);
					assert.equal(error.message.includes("fixture"), false);
					return true;
				},
			);
		}
	});

	test("a tunnel request names an IPv6 target in brackets (#5473)", () => {
		assert.equal(authorityOf({ host: "db.example.com", port: 5432 }), "db.example.com:5432");
		assert.equal(authorityOf({ host: "2001:db8::1", port: 5432 }), "[2001:db8::1]:5432");
		assert.equal(authorityOf({ host: "[2001:db8::1]", port: 6432 }), "[2001:db8::1]:6432");
	});
});

describe("PostgreSQL proxy tunnel (#5473)", () => {
	const target = { host: "db.example.com", port: 5432 };

	test("asks for CONNECT with the target and credentials, and carries the target's bytes after a 200 (#5473)", async () => {
		const proxy = await fakeProxy((socket) => {
			// Bytes the proxy passes on right after its answer reach the caller first.
			socket.write("HTTP/1.1 200 Connection established\r\n\r\nS");
			socket.on("data", (chunk: Buffer) => socket.write(chunk));
		});
		try {
			const socket = await openProxyTunnel(proxyAt(proxy.port, "agent:secret@"), target);
			const echoed = await new Promise<string>((resolve) => {
				let text = "";
				socket.on("data", (chunk: Buffer) => {
					text += chunk.toString("latin1");
					if (text.length >= 5) resolve(text);
				});
				socket.resume();
				socket.write("ping");
			});
			socket.destroy();
			assert.equal(echoed, "Sping");
			assert.match(
				proxy.requests[0]!,
				/^CONNECT db\.example\.com:5432 HTTP\/1\.1\r\nHost: db\.example\.com:5432\r\n/,
			);
			assert.match(
				proxy.requests[0]!,
				new RegExp(`Proxy-Authorization: Basic ${Buffer.from("agent:secret").toString("base64")}\r\n`),
			);
		} finally {
			proxy.server.close();
		}
	});

	test.each([
		["CRLF", "\r\n", "\r\n"],
		["LF", "\n", "\n"],
		["mixed", "\n", "\r\n"],
	])(
		"waits through informational replies with %s endings and keeps the tunnel bytes (#5565)",
		async (_, eol, blank) => {
			const payload = Buffer.from([0x00, 0x0d, 0x0a, 0xff]);
			const proxy = await fakeProxy((socket) => {
				socket.write(`HTTP/1.1 100 Continue${eol}${blank}H`);
				const rest = `TTP/1.1 103 Early Hints${eol}Link: </db>${blank}${eol}HTTP/1.1 102 Processing${eol}${blank}HTTP/1.1 199 Misc${eol}${blank}HTTP/1.1 204 No Content${eol}${blank}`;
				setImmediate(() => socket.end(Buffer.concat([Buffer.from(rest), payload])));
			});
			try {
				const socket = await openProxyTunnel(proxyAt(proxy.port), target);
				assert.deepEqual(await buffer(socket), payload);
			} finally {
				proxy.server.close();
			}
		},
	);

	test("limits all CONNECT headers together to 16 KiB, not counting tunnel bytes (#5565)", async () => {
		const limit = 16 * 1024;
		const interim = "HTTP/1.1 103 Early Hints\r\n\r\n";
		const final = "HTTP/1.1 200 OK\r\nX-Pad: ";
		const end = "\r\n\r\n";
		const padded = (extra: number) =>
			interim + final + "x".repeat(limit - interim.length - final.length - end.length + extra) + end;
		const payload = Buffer.alloc(limit + 1, 0xee);
		const exact = await fakeProxy((socket) => socket.end(Buffer.concat([Buffer.from(padded(0)), payload])));
		try {
			const socket = await openProxyTunnel(proxyAt(exact.port), target);
			assert.deepEqual(await buffer(socket), payload);
		} finally {
			exact.server.close();
		}

		for (const answer of [padded(1), interim.repeat(Math.ceil(limit / interim.length))]) {
			const proxy = await fakeProxy((socket) => socket.end(answer));
			try {
				await assert.rejects(openProxyTunnel(proxyAt(proxy.port), target), { code: "proxy-protocol" });
			} finally {
				proxy.server.close();
			}
		}
	});

	test("a bare CR in a header field value reads as a space, and the final status decides (#5670)", async () => {
		const payload = Buffer.from([0x00, 0x0d, 0xff]);
		for (const [first, rest, expected] of [
			["HTTP/1.1 200 OK\r\nX-Test: value\r", "bad\r\n\r\n", "open"],
			["HTTP/1.1 200 OK\r\nVia: a\r", "\r\n\r\n", "open"],
			["HTTP/1.1 103 Early Hints\r\nLink: a\r", "b\r\n\r\nHTTP/1.1 200 OK\r\n\r\n", "open"],
			["HTTP/1.1 407 Proxy Authentication Required\r\nX: a\r", "b\r\n\r\n", "proxy-auth-required"],
			["HTTP/1.1 502 Bad Gateway\r\nX: a\r", "b\r\n\r\n", "proxy-upstream"],
			["HTTP/1.1 403 Forbidden\r\nX: a\r", "b\r\n\r\n", "proxy-refused"],
		] as const) {
			const proxy = await fakeProxy((socket) => {
				socket.write(first);
				setImmediate(() => socket.end(Buffer.concat([Buffer.from(rest), payload])));
			});
			try {
				if (expected === "open") {
					const socket = await openProxyTunnel(proxyAt(proxy.port), target);
					assert.deepEqual(await buffer(socket), payload);
				} else await assert.rejects(openProxyTunnel(proxyAt(proxy.port), target), { code: expected });
			} finally {
				proxy.server.close();
			}
		}
	});

	test("a proxy connection that closes right after a CR is closed, not malformed, and is retried (#5670)", async () => {
		for (const answer of [
			"HTTP/1.1 200 Connection established\r",
			"HTTP/1.1 200 OK\r\nX-Test: value\r",
			"HTTP/1.1 200 OK\r\n\r",
			"HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 200 OK\r",
		]) {
			const proxy = await fakeProxy((socket) => socket.end(answer));
			try {
				await assert.rejects(openProxyTunnel(proxyAt(proxy.port), target), {
					code: "proxy-closed",
					permanent: false,
				});
			} finally {
				proxy.server.close();
			}
		}
	});

	test("a bare CR in a status line is a protocol error, and a CR where HTTP/ should start one at once (#5670)", async () => {
		// `undefined`: the proxy then stays silent. A CR where `HTTP/` should be cannot start an answer, so the open does
		// not wait for the deadline and retry it.
		for (const [first, rest] of [
			["HTTP/1.1 200 O\r", "K\r\n\r\n"],
			["HTTP/1.1 103 Early\r", "Hints\r\n\r\nHTTP/1.1 200 OK\r\n\r\n"],
			["HTT\r", undefined],
			["\r", undefined],
			["HTTP/1.1 103 Early Hints\r\n\r\n\r", undefined],
		] as const) {
			const proxy = await fakeProxy((socket) => {
				socket.write(first);
				if (rest !== undefined) setImmediate(() => socket.end(rest));
			});
			try {
				await assert.rejects(openProxyTunnel(proxyAt(proxy.port), target, { timeoutMs: 2_000 }), {
					code: "proxy-protocol",
					permanent: true,
				});
			} finally {
				proxy.server.close();
			}
		}
	});

	test("reports the final refusal, and does not skip 101 Switching Protocols (#5565)", async () => {
		for (const [status, code, permanent] of [
			[101, "proxy-refused", true],
			[407, "proxy-auth-required", true],
			[502, "proxy-upstream", false],
		] as const) {
			const proxy = await fakeProxy((socket) =>
				socket.end(`HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 ${status}\r\n\r\nHTTP/1.1 200 OK\r\n\r\n`),
			);
			try {
				await assert.rejects(openProxyTunnel(proxyAt(proxy.port), target), { code, status, permanent });
			} finally {
				proxy.server.close();
			}
		}
	});

	test("informational replies do not extend the CONNECT deadline (#5565)", async () => {
		const interim = "HTTP/1.1 103 Early Hints\r\n\r\n";
		const proxy = await fakeProxy((socket) => {
			socket.write(interim);
			const pulse = setInterval(() => socket.write(interim), 10);
			socket.once("close", () => clearInterval(pulse));
		});
		try {
			await assert.rejects(openProxyTunnel(proxyAt(proxy.port), target, { timeoutMs: 500 }), {
				code: "proxy-timeout",
			});
		} finally {
			proxy.server.close();
		}
	});

	test("an answer that arrives a few bytes at a time still opens the tunnel (#5473)", async () => {
		const answer = "HTTP/1.1 200 Connection established\r\n\r\n";
		for (const split of [1, 2, 3, 4, 7]) {
			const proxy = await fakeProxy((socket) => {
				socket.setNoDelay(true);
				socket.write(answer.slice(0, split));
				setTimeout(() => socket.write(answer.slice(split)), 20);
			});
			try {
				const socket = await openProxyTunnel(proxyAt(proxy.port), target);
				socket.destroy();
			} finally {
				proxy.server.close();
			}
		}
	});

	test("refusals, failures and silence are told apart, permanent or not, naming the proxy and target (#5473)", async () => {
		const cases: [string | ((socket: Socket) => void), ProxyTunnelError["code"], boolean, RegExp][] = [
			[
				"HTTP/1.1 403 Forbidden\r\n\r\n",
				"proxy-refused",
				true,
				/refused the tunnel to db\.example\.com:5432 \(403 Forbidden\)/,
			],
			[
				"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n",
				"proxy-auth-required",
				true,
				/without accepted credentials \(407 Proxy Authentication Required\)/,
			],
			[
				"HTTP/1.1 502 Bad Gateway\r\n\r\n",
				"proxy-upstream",
				false,
				/could not open the tunnel to db\.example\.com:5432 \(502 Bad Gateway\)/,
			],
			["SSH-2.0-OpenSSH\r\n\r\n", "proxy-protocol", true, /with something other than HTTP/],
			["\x00\x01\x02\x03\x04", "proxy-protocol", true, /with something other than HTTP/],
			[(socket) => socket.end(), "proxy-closed", false, /closed the connection before answering/],
		];
		for (const [answer, code, permanent, message] of cases) {
			const proxy = await fakeProxy((socket) =>
				typeof answer === "string" ? socket.write(answer) : answer(socket),
			);
			try {
				const error = await tunnelFailure(openProxyTunnel(proxyAt(proxy.port, "agent:fixture-secret@"), target));
				assert.equal(error.code, code, error.message);
				assert.equal(error.permanent, permanent, code);
				assert.match(error.message, message);
				assert.match(error.message, new RegExp(`^the proxy http://127\\.0\\.0\\.1:${proxy.port} `));
				assert.equal(error.message.includes("fixture-secret"), false);
			} finally {
				proxy.server.close();
			}
		}

		const silent = await fakeProxy(() => {});
		try {
			const error = await tunnelFailure(openProxyTunnel(proxyAt(silent.port), target, { timeoutMs: 100 }));
			assert.equal(error.code, "proxy-timeout");
			assert.equal(error.permanent, false);
			assert.match(error.message, /did not answer the tunnel request to db\.example\.com:5432 within 100 ms/);
		} finally {
			silent.server.close();
		}

		// An address nothing answers at (TEST-NET-1): the proxy is not reached at all, which is not a proxy that is silent.
		const dropped = await tunnelFailure(
			openProxyTunnel(parseProxy("http://192.0.2.1:3128", "HTTPS_PROXY"), target, { timeoutMs: 300 }),
		);
		assert.equal(dropped.code, "proxy-unreachable", dropped.message);
		assert.equal(dropped.permanent, false);
		assert.match(
			dropped.message,
			/^the proxy http:\/\/192\.0\.2\.1:3128 could not be reached for the tunnel to db\.example\.com:5432 \(/,
		);

		const unreachable = await fakeProxy(() => {});
		const port = unreachable.port;
		await new Promise<void>((resolve) => unreachable.server.close(() => resolve()));
		const error = await tunnelFailure(openProxyTunnel(proxyAt(port), target));
		assert.equal(error.code, "proxy-unreachable");
		assert.equal(error.permanent, false);
		assert.match(error.message, /could not be reached for the tunnel to db\.example\.com:5432 \(ECONNREFUSED\)/);
	});
});

describe("PostgreSQL retry warnings through a proxy (#5473)", () => {
	test("the warning an open's retries print names the proxy that failed, and a direct failure the database server (#5473)", async () => {
		const warnings: string[] = [];
		const onWarning = (warning: Error) => warnings.push(warning.message);
		const upstream = await fakeProxy((socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
		const unreachablePort = await closedPort();
		const serverPort = await closedPort();
		const opening = (url: string, proxy?: string) =>
			openPostgresDatabase({ url, password: "fixture-password", ...(proxy === undefined ? {} : { proxy }) }).then(
				async (database) => {
					await database.close();
					assert.fail(`${url} opened`);
				},
				(error: Error) => error,
			);
		process.on("warning", onWarning);
		try {
			const failures = await Promise.all([
				opening(
					"postgresql://atomic@unreachable.example.test:5432/atomic",
					`http://agent:fixture-proxy-secret@127.0.0.1:${unreachablePort}`,
				),
				opening("postgresql://atomic@upstream.example.test:5432/atomic", `http://127.0.0.1:${upstream.port}`),
				opening(`postgresql://atomic@127.0.0.1:${serverPort}/atomic`),
			]);
			assert.equal(failures.length, 3);
		} finally {
			process.off("warning", onWarning);
			upstream.server.close();
		}
		const warningFor = (host: string) => {
			const found = warnings.filter((warning) => warning.includes(`@${host}`));
			assert.equal(found.length, 1, `one warning for ${host}: ${warnings.join("\n")}`);
			return found[0]!;
		};
		const unreachable = warningFor("unreachable.example.test");
		assert.ok(
			unreachable.includes(
				`: the proxy http://127.0.0.1:${unreachablePort} could not be reached for the tunnel to unreachable.example.test:5432 (ECONNREFUSED) on attempt 1 (connection-refused). Check that the proxy http://127.0.0.1:${unreachablePort} is reachable and`,
			),
			unreachable,
		);
		assert.equal(unreachable.includes("fixture-proxy-secret"), false, unreachable);
		const failed = warningFor("upstream.example.test");
		assert.ok(
			failed.includes(
				`: the proxy http://127.0.0.1:${upstream.port} could not open the tunnel to upstream.example.test:5432 (502 Bad Gateway) on attempt 1 (connection-refused). Check that the proxy http://127.0.0.1:${upstream.port} is reachable and`,
			),
			failed,
		);
		// A server that is not there is still reported as the database server.
		const direct = warningFor(`127.0.0.1:${serverPort}`);
		assert.ok(
			direct.includes(
				": the database server call failed on attempt 1 (connection-refused). Check that the database server is reachable and",
			),
			direct,
		);
		for (const warning of [unreachable, failed])
			assert.equal(warning.includes("the database server"), false, warning);
	});
});
