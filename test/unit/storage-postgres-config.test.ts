import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { loadStorageAdapter, StorageConfigError, StorageUnavailableError } from "@bastani/atomic/storage";
import { test } from "vitest";
import adapter, { numberPlaceholders, openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

/** Asserts that `open` fails with `StorageConfigError` for `field`/`reason`, and that no secret reaches the error. */
async function assertRefused(
	open: () => Promise<unknown>,
	field: string,
	reason: string,
	secrets: readonly string[] = [],
): Promise<void> {
	await assert.rejects(open, (error: Error) => {
		assert.ok(error instanceof StorageConfigError, inspect(error));
		assert.equal(error.field, field);
		assert.equal(error.reason, reason);
		const rendered = inspect(error, { depth: null });
		for (const secret of secrets) assert.equal(rendered.includes(secret), false, `${secret} leaked: ${rendered}`);
		return true;
	});
}

test("Postgres refuses a password in the URL's userinfo without connecting (#4793)", async () => {
	for (const url of [
		"postgres://atomic:fixture-secret@127.0.0.1:1/atomic",
		"postgresql://atomic:fixture-secret@db.invalid/atomic?sslmode=verify-full",
	])
		await assertRefused(() => openPostgresDatabase({ url }), "url", "credential-in-url", ["fixture-secret"]);
});

test("Postgres refuses a password query parameter in the URL (#4793)", async () => {
	for (const url of [
		"postgres://atomic@127.0.0.1:1/atomic?password=fixture-secret",
		"postgres://atomic@127.0.0.1:1/atomic?sslmode=disable&PASSWORD=fixture-secret",
		"postgres://atomic@127.0.0.1:1/atomic?pass%77ord=fixture-secret",
	])
		await assertRefused(() => openPostgresDatabase({ url }), "url", "credential-in-url", ["fixture-secret"]);
});

test("Postgres refuses a listen URL that holds a password or is not a Postgres URL, naming listenUrl (#5103)", async () => {
	const url = "postgres://atomic@127.0.0.1:1/atomic";
	await assertRefused(
		() => openPostgresDatabase({ url, listenUrl: "postgres://atomic:fixture-secret@127.0.0.1:1/atomic" }),
		"listenUrl",
		"credential-in-url",
		["fixture-secret"],
	);
	for (const listenUrl of ["http://127.0.0.1:1/atomic", "not a url"]) {
		await assertRefused(() => openPostgresDatabase({ url, listenUrl }), "listenUrl", "unsupported-url");
		await assert.rejects(openPostgresDatabase({ url, listenUrl }), {
			hint: "Use a postgres:// or postgresql:// URL",
		});
	}
	await assertRefused(
		() =>
			adapter.openDatabase(
				{ url, listenUrl: "postgres://atomic@127.0.0.1:1/atomic?password=fixture-secret" },
				{ agentDir: "/nonexistent", domain: "sessions" },
			),
		"listenUrl",
		"credential-in-url",
		["fixture-secret"],
	);
});

test("Postgres refuses URLs that are not postgres:// or postgresql:// (#4793)", async () => {
	for (const url of ["libsql://db.turso.io", "file:/tmp/db.sqlite", "http://127.0.0.1:5432/db", "not a url", ""])
		await assertRefused(() => openPostgresDatabase({ url }), "url", "unsupported-url");
});

test("Postgres refuses cloud auth together with a password, and auth modes it does not know (#4793)", async () => {
	for (const password of ["fixture-secret", async () => "fixture-secret"])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", auth: "gcp-iam", password }),
			"auth",
			"conflicting-token",
			["fixture-secret"],
		);
	await assertRefused(
		() =>
			openPostgresDatabase({
				url: "postgres://atomic@127.0.0.1:1/atomic",
				// @ts-expect-error an auth mode the adapter does not know
				auth: "kerberos",
			}),
		"auth",
		"unsupported-auth",
	);
});

test("Postgres refuses AWS IAM auth for a URL without a user before connecting (#4793)", async () => {
	await assertRefused(
		() => openPostgresDatabase({ url: "postgres://db.eu-west-2.rds.amazonaws.com/atomic", auth: "aws-iam" }),
		"auth",
		"invalid-auth-target",
	);
});

test("Postgres refuses connection limits that are not positive integers (#4793)", async () => {
	// A count given as text, as settings could hold one, is refused too.
	for (const maxConnections of [0, -1, 1.5, Number.NaN, "8" as unknown as number])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", maxConnections }),
			"maxConnections",
			"positive-integer-required",
		);
	for (const statementTimeoutMs of [0, -5, 2.5])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", statementTimeoutMs }),
			"statementTimeoutMs",
			"positive-integer-required",
		);
	for (const idleTimeoutMs of [0, -5, 2.5])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", idleTimeoutMs }),
			"idleTimeoutMs",
			"positive-integer-required",
		);
	for (const connectTimeoutMs of [0, -5, 2.5, "10000" as unknown as number])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", connectTimeoutMs }),
			"connectTimeoutMs",
			"positive-integer-required",
		);
	for (const keepAliveIdleMs of [0, -5, 2.5])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", keepAliveIdleMs }),
			"keepAliveIdleMs",
			"positive-integer-required",
		);
	// 0 is allowed: it turns the separate pool for reads off.
	for (const readerMaxConnections of [-1, 1.5, Number.NaN, "2" as unknown as number])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", readerMaxConnections }),
			"readerMaxConnections",
			"non-negative-integer-required",
		);
	for (const maxPreparedStatements of [-1, 2.5, "256"])
		await assertRefused(
			() =>
				openPostgresDatabase({
					url: "postgres://atomic@127.0.0.1:1/atomic",
					maxPreparedStatements: maxPreparedStatements as number,
				}),
			"maxPreparedStatements",
			"non-negative-integer-required",
		);
});

test("the Postgres adapter module declares its password as a live secret (#4793)", () => {
	assert.equal(adapter.atomicStorageAdapter, 1);
	assert.deepEqual(adapter.liveSecrets, ["password"]);
});

test("Postgres refuses a proxy with a socket factory, a socket factory that is not a function, and a proxy that is not an http(s) URL, without connecting (#5473)", async () => {
	const url = "postgres://atomic@db.invalid/atomic";
	let opened = 0;
	const socket = () => {
		opened += 1;
		throw new Error("the socket factory was called");
	};
	for (const proxy of ["http://127.0.0.1:1", "none"])
		await assertRefused(() => openPostgresDatabase({ url, proxy, socket }), "proxy", "conflicting-transport");
	assert.equal(opened, 0);
	for (const invalid of ["net.connect", {}, 5])
		await assertRefused(
			() => openPostgresDatabase({ url, socket: invalid as unknown as () => never }),
			"socket",
			"invalid-socket-factory",
		);
	await assertRefused(
		() => openPostgresDatabase({ url, proxy: "socks5://agent:fixture-secret@127.0.0.1:1080" }),
		"proxy",
		"unsupported-proxy",
		["fixture-secret"],
	);
	// A value that is not a string, as settings could hold one.
	await assertRefused(
		() => adapter.openDatabase({ url, proxy: 3128 }, { agentDir: "/nonexistent", domain: "sessions" }),
		"proxy",
		"unsupported-proxy",
	);
});

test("the Postgres adapter requires a URL option (#4793)", async () => {
	for (const url of [undefined, "", 5])
		await assertRefused(
			() => adapter.openDatabase(url === undefined ? {} : { url }, { agentDir: "/nonexistent", domain: "sessions" }),
			"url",
			"unsupported-url",
		);
});

test("Atomic loads the installed Postgres package by name as a storage adapter (#4793)", async () => {
	const agentDir = makeTempDirectory("storage-postgres-agent-");
	try {
		const packageRoot = resolve(moduleDir(import.meta.url), "../../packages/storage-postgres");
		await writeFileEnsuringDir(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		const loaded = await loadStorageAdapter("@bastani/atomic-storage-postgres", { agentDir, domain: "sessions" });
		assert.deepEqual(loaded.liveSecrets, ["password"]);
		assert.ok(loaded.openDatabase);
		await assertRefused(
			() =>
				loaded.openDatabase?.(
					{ url: "postgres://atomic:fixture-secret@127.0.0.1:1/atomic" },
					{ agentDir, domain: "sessions" },
				) ?? Promise.resolve(),
			"url",
			"credential-in-url",
			["fixture-secret"],
		);
	} finally {
		removeTempDirectory(agentDir);
	}
});

/** An open that fails to connect gives up only after the facade's five runs and their backoff, about four seconds. */
const FAILED_OPEN_TIMEOUT_MS = 20_000;

/** Read the adapter's effective URL without relying on DNS or the OS refusing a TCP connection. */
async function failedOpenLocation(url: string): Promise<string> {
	const error = await openPostgresDatabase({
		url,
		socket: () => {
			throw Object.assign(new Error("fixture refused the TCP connection"), { code: "ECONNREFUSED" });
		},
	}).catch((caught) => caught);
	assert.ok(error instanceof StorageUnavailableError, inspect(error));
	return error.location;
}

test(
	"Postgres requires a verified TLS connection to a host that is not this machine, unless the URL says otherwise (#4793)",
	async () => {
		const verified = [
			"postgres://atomic@db.invalid:1/atomic",
			"postgres://atomic@127.db.invalid:1/atomic",
			"postgres://atomic@localhost.invalid:1/atomic",
			"postgres://atomic@127.0.0.1:1/atomic?host=db.invalid",
		];
		const unchanged = [
			"postgres://atomic@127.0.0.1:1/atomic",
			"postgres://atomic@127.1.2.3:1/atomic",
			"postgres://atomic@localhost:1/atomic",
			"postgres://atomic@LOCALHOST:1/atomic",
			"postgres://atomic@[::1]:1/atomic",
			"postgres:///atomic?host=/nonexistent-socket-directory&port=1",
			"postgres://atomic@db.invalid:1/atomic?sslmode=disable",
		];
		const locations = await Promise.all([...verified, ...unchanged].map(failedOpenLocation));
		assert.deepEqual(locations, [
			...verified.map((url) => {
				const parsed = new URL(url);
				parsed.searchParams.set("sslmode", "verify-full");
				return parsed.href;
			}),
			...unchanged,
		]);
	},
	FAILED_OPEN_TIMEOUT_MS,
);

test(
	"every spelling of this machine that is reached without a proxy also gets no default sslmode (#5473)",
	async () => {
		const local = [
			"postgres://atomic@127.1:1/atomic",
			"postgres://atomic@localhost.:1/atomic",
			"postgres://atomic@[::ffff:127.0.0.1]:1/atomic",
			"postgres://atomic@db.invalid:1/atomic?host=127.1",
		];
		const locations = await Promise.all(local.map(failedOpenLocation));
		assert.deepEqual(locations, local);
	},
	FAILED_OPEN_TIMEOUT_MS,
);

test("numbers ? parameters only outside literals, quoted identifiers, dollar quotes and comments (#4793)", () => {
	const cases: [string, string][] = [
		["SELECT 1", "SELECT 1"],
		["SELECT ?, ?", "SELECT $1, $2"],
		["SELECT ?,?", "SELECT $1,$2"],
		["SELECT '?', ?", "SELECT '?', $1"],
		["SELECT 'it''s ?', ?", "SELECT 'it''s ?', $1"],
		["SELECT 'a\\', ?", "SELECT 'a\\', $1"],
		["SELECT E'\\' ?', ?", "SELECT E'\\' ?', $1"],
		["SELECT e'can''t \\' ?', ?", "SELECT e'can''t \\' ?', $1"],
		["SELECT somE'\\', ?", "SELECT somE'\\', $1"],
		['SELECT "?" FROM "a""?", ?', 'SELECT "?" FROM "a""?", $1'],
		["SELECT ? -- ?\n, ?", "SELECT $1 -- ?\n, $2"],
		["SELECT ? -- ?", "SELECT $1 -- ?"],
		["SELECT ? - ?", "SELECT $1 - $2"],
		["SELECT ? / ?", "SELECT $1 / $2"],
		["SELECT /* ? /* ? */ ? */ ?", "SELECT /* ? /* ? */ ? */ $1"],
		["SELECT /* ? */ ? /* ? */ ?", "SELECT /* ? */ $1 /* ? */ $2"],
		["SELECT /* ? /* ?", "SELECT /* ? /* ?"],
		["SELECT $$?$$, ?", "SELECT $$?$$, $1"],
		["SELECT $tag$ ? $$ ? $tag$, ?", "SELECT $tag$ ? $$ ? $tag$, $1"],
		["SELECT $tag$ ?", "SELECT $tag$ ?"],
		["SELECT a$b$c, ?, $1x$", "SELECT a$b$c, $1, $1x$"],
		["SELECT 'open ?", "SELECT 'open ?"],
		['SELECT "open ?', 'SELECT "open ?'],
		["SELECT ?", "SELECT $1"],
		["?", "$1"],
	];
	for (const [sql, numbered] of cases) assert.equal(numberPlaceholders(sql), numbered, sql);
});

test("leaves ? alone inside dollar quotes whose tags hold any non-ASCII character (#4834)", () => {
	const cases: [string, string][] = [
		["SELECT $😀$ a ? b $😀$, ?", "SELECT $😀$ a ? b $😀$, $1"],
		["SELECT $·$?$·$, ?", "SELECT $·$?$·$, $1"],
		["SELECT $a·1$?$a·1$, ?", "SELECT $a·1$?$a·1$, $1"],
		["SELECT x·$a$ + ? FROM (SELECT ?::int AS x·$a$) s", "SELECT x·$a$ + $1 FROM (SELECT $2::int AS x·$a$) s"],
		["SELECT 😀E'\\', ?", "SELECT 😀E'\\', $1"],
	];
	for (const [sql, numbered] of cases) assert.equal(numberPlaceholders(sql), numbered, sql);
});

test("a ? right after an identifier becomes a parameter separate from it (#4834)", () => {
	const cases: [string, string][] = [
		["SELECT x?", "SELECT x $1"],
		["SELECT col?, ?", "SELECT col $1, $2"],
		["SELECT x·?, 😀?", "SELECT x· $1, 😀 $2"],
		["SELECT 1 WHERE a.b=?", "SELECT 1 WHERE a.b=$1"],
		["SELECT (?)+?", "SELECT ($1)+$2"],
		["SELECT ? x", "SELECT $1 x"],
	];
	for (const [sql, numbered] of cases) assert.equal(numberPlaceholders(sql), numbered, sql);
});

test("a ? anywhere inside a dollar-quoted string never changes the parameter count, and a parameter after an identifier stays separate (#4834)", () => {
	// mulberry32: a fixed seed makes every failure reproducible.
	let state = 4834;
	const random = () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const pick = (choices: string[]) => choices[Math.floor(random() * choices.length)] as string;
	const tagStart = ["a", "Z", "_", "é", "·", "😀", "中", "٣", "\u00a0", "\u2028", "€"];
	const tagContinue = [...tagStart, "0", "9"];
	const body = ["x", " ", "'", '"', "-", "/", "*", "$", "\\", "\n", "·", "😀", "?", "E", "1"];
	const before = [" ", ",", "(", "\n", "="];
	const word = ["x", "·", "😀", "1", "_"];
	const lead = ["", " ", "(", "=", ...word];
	let checked = 0;
	while (checked < 2000) {
		const length = Math.floor(random() * 4);
		let name = length === 0 ? "" : pick(tagStart);
		for (let i = 1; i < length; i++) name += pick(tagContinue);
		const tag = `$${name}$`;
		const text = Array.from({ length: Math.floor(random() * 12) }, () => pick(body));
		const at = Math.floor(random() * (text.length + 1));
		const inside = [...text.slice(0, at), "?", ...text.slice(at)].join("");
		const quoted = `${tag}${inside}${tag}`;
		// The body must not close the quote early.
		if (quoted.indexOf(tag, tag.length) !== tag.length + inside.length) continue;
		const last = pick(lead);
		const sql = `SELECT${pick(before)}${quoted}, ${last}?`;
		const separator = word.includes(last) ? " " : "";
		assert.equal(numberPlaceholders(sql), `${sql.slice(0, -1)}${separator}$1`, sql);
		checked++;
	}
});

test("the Postgres adapter checks the options settings give it before connecting (#4793)", async () => {
	const context = { agentDir: "/nonexistent", domain: "sessions" } as const;
	const url = "postgres://atomic@127.0.0.1:1/atomic";
	await assertRefused(
		() => adapter.openDatabase({ url, maxConnections: 0 }, context),
		"maxConnections",
		"positive-integer-required",
	);
	await assertRefused(
		() => adapter.openDatabase({ url, statementTimeoutMs: -1 }, context),
		"statementTimeoutMs",
		"positive-integer-required",
	);
	await assertRefused(
		() => adapter.openDatabase({ url, idleTimeoutMs: "300000" }, context),
		"idleTimeoutMs",
		"positive-integer-required",
	);
	await assertRefused(
		() => adapter.openDatabase({ url, readerMaxConnections: -1 }, context),
		"readerMaxConnections",
		"non-negative-integer-required",
	);
	await assertRefused(
		() => adapter.openDatabase({ url, connectTimeoutMs: 0 }, context),
		"connectTimeoutMs",
		"positive-integer-required",
	);
	await assertRefused(
		() => adapter.openDatabase({ url, keepAliveIdleMs: "60000" }, context),
		"keepAliveIdleMs",
		"positive-integer-required",
	);
	await assertRefused(
		() => adapter.openDatabase({ url, maxPreparedStatements: -1 }, context),
		"maxPreparedStatements",
		"non-negative-integer-required",
	);
	await assertRefused(() => adapter.openDatabase({ url, auth: "kerberos" }, context), "auth", "unsupported-auth");
	await assertRefused(
		() => adapter.openDatabase({ url: "postgres://atomic:fixture-secret@127.0.0.1:1/atomic" }, context),
		"url",
		"credential-in-url",
		["fixture-secret"],
	);
});

test("Postgres refuses a TLS parameter whose name is not lowercase, which pg would ignore and connect without TLS (#5113)", async () => {
	for (const url of [
		"postgres://atomic@db.example.com/atomic?SSLMODE=verify-full",
		"postgres://atomic@db.example.com/atomic?SslMode=require",
		"postgres://atomic@db.example.com/atomic?sslmode=verify-full&SSLROOTCERT=/etc/ca.pem",
		"postgres://atomic@db.example.com/atomic?UseLibpqCompat=true",
	])
		await assertRefused(() => openPostgresDatabase({ url }), "url", "tls-parameter-case");
});

test("Postgres refuses an sslmode libpq does not know, whatever uselibpqcompat says (#5113)", async () => {
	for (const url of [
		"postgres://atomic@db.example.com/atomic?sslmode=REQUIRE",
		"postgres://atomic@db.example.com/atomic?sslmode=bogus&uselibpqcompat=true",
		"postgres://atomic@127.0.0.1:1/atomic?sslmode=",
		"postgres://atomic@127.0.0.1:1/atomic?sslmode=no-verify",
	])
		await assertRefused(() => openPostgresDatabase({ url }), "url", "unsupported-sslmode");
});
