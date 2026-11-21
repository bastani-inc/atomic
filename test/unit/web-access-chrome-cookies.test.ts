import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import { getGoogleCookies } from "../../packages/web-access/chrome-cookies.js";
import {
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

function encryptChromiumCookie(
	plaintext: string,
	password: string,
	iterations: number,
	includeHashPrefix: boolean,
): Buffer {
	const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
	const iv = Buffer.alloc(16, 0x20);
	const payload = Buffer.concat([
		includeHashPrefix ? Buffer.alloc(32, 0xaa) : Buffer.alloc(0),
		Buffer.from(plaintext, "utf8"),
	]);
	const padLen = 16 - (payload.length % 16);
	const padded = Buffer.concat([payload, Buffer.alloc(padLen, padLen)]);
	const cipher = createCipheriv("aes-128-cbc", key, iv);
	cipher.setAutoPadding(false);
	return Buffer.concat([Buffer.from("v10", "utf8"), cipher.update(padded), cipher.final()]);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** A home directory with a Chromium cookie database and a `secret-tool` that returns its password. */
function makeCookieHome(): { home: string; binDir: string } {
	const home = makeTempDirectory("chrome-cookies-home-");
	const binDir = join(home, "bin");
	mkdirSync(binDir);
	writeFileSync(
		join(binDir, "secret-tool"),
		`#!/bin/sh
printf '%s\\n' "$*" > "$HOME/secret-tool-args"
printf '%s\\n' 'fixture-cookie-password'
`,
		{ mode: 0o700 },
	);
	const cookiesPath = join(home, ".config/chromium", "Default", "Cookies");
	mkdirSync(dirname(cookiesPath), { recursive: true });
	const db = new DatabaseSync(cookiesPath);
	try {
		db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER)");
		db.exec("CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, encrypted_value BLOB, expires_utc INTEGER)");
		db.prepare("INSERT INTO meta (key, value) VALUES ('version', 24)").run();
		const encryptedSid = encryptChromiumCookie("decrypted-psid", "fixture-cookie-password", 1, true);
		db.prepare(
			"INSERT INTO cookies (name, value, host_key, encrypted_value, expires_utc) VALUES (?, ?, ?, ?, ?)",
		).run("__Secure-1PSID", "", ".google.com", encryptedSid, 100);
		db.prepare(
			"INSERT INTO cookies (name, value, host_key, encrypted_value, expires_utc) VALUES (?, ?, ?, ?, ?)",
		).run("__Secure-1PSIDTS", "plain-psidts", "gemini.google.com", new Uint8Array(0), 200);
	} finally {
		db.close();
	}
	return { home, binDir };
}

const FIXTURE_COOKIES = { "__Secure-1PSID": "decrypted-psid", "__Secure-1PSIDTS": "plain-psidts" };

test.runIf(process.platform === "linux")(
	"getGoogleCookies decrypts Chromium cookies without querying SQLite on the main thread (#5377)",
	async () => {
		const { home, binDir } = makeCookieHome();
		vi.stubEnv("HOME", home);
		vi.stubEnv("PATH", binDir);
		try {
			const mainThreadQueries = vi.spyOn(DatabaseSync.prototype, "prepare");
			const result = await getGoogleCookies({
				requiredCookies: ["__Secure-1PSID", "__Secure-1PSIDTS"],
			});
			assert.ok(result);
			assert.equal(result.cookies["__Secure-1PSID"], "decrypted-psid");
			assert.equal(result.cookies["__Secure-1PSIDTS"], "plain-psidts");
			assert.equal(mainThreadQueries.mock.calls.length, 0, "SQLite queries must run off the main thread");
			assert.equal(readFileSync(join(home, "secret-tool-args"), "utf8"), "lookup application chromium\n");
		} finally {
			removeTempDirectory(home);
		}
	},
);

// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;
const COUNTING_PRELOAD = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.ATOMIC_TEST_PRELOAD_LOG, "ran\\n");`;
const dataUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const COOKIES_MODULE = JSON.stringify(
	pathToFileURL(join(moduleDir(import.meta.url), "../../packages/web-access/chrome-cookies.ts")).href,
);

/** Reads the fixture's cookies in a Node child started with `flags` and `env`, which loads the reader from source. */
function readCookiesInChild(flags: readonly string[], script: string, env: Record<string, string> = {}): unknown {
	const { home, binDir } = makeCookieHome();
	try {
		// The child reads one small database and ends within seconds. The bound ends one that would never end (a worker
		// that never answers keeps it alive), so that the test fails instead of stalling the run, and leaves room for a
		// loaded machine. A child ended for running past it throws ETIMEDOUT here.
		const CHILD_TIMEOUT_MS = 60_000;
		const result = spawnSyncCollect(
			[process.execPath, ...flags, "--import", dataUrl(RESOLVE_TS_SOURCES), "--eval", script],
			{
				env: { HOME: home, PATH: binDir, ATOMIC_TEST_PRELOAD_LOG: join(home, "preload.log"), ...env },
				timeout: CHILD_TIMEOUT_MS,
			},
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		return {
			read: JSON.parse(result.stdout.toString()),
			preloadRuns: fileExistsSync(join(home, "preload.log"))
				? readFileSync(join(home, "preload.log"), "utf8").split("\n").filter(Boolean).length
				: 0,
		};
	} finally {
		removeTempDirectory(home);
	}
}

test.runIf(process.platform === "linux")(
	"getGoogleCookies reads cookies from a process started with --input-type=module and runs its preload once (#6079)",
	() => {
		const outcome = readCookiesInChild(
			["--import", dataUrl(COUNTING_PRELOAD), "--input-type=module"],
			`import { getGoogleCookies } from ${COOKIES_MODULE};
			const found = await getGoogleCookies({ requiredCookies: ["__Secure-1PSID", "__Secure-1PSIDTS"] });
			process.stdout.write(JSON.stringify(found));`,
		);
		assert.deepEqual(outcome, { read: { cookies: FIXTURE_COOKIES, warnings: [] }, preloadRuns: 1 });
	},
);

test.runIf(process.platform === "linux")(
	"getGoogleCookies reads cookies in a process whose NODE_OPTIONS holds --input-type=module (#6110)",
	() => {
		const outcome = readCookiesInChild(
			["--import", dataUrl(COUNTING_PRELOAD)],
			`import { getGoogleCookies } from ${COOKIES_MODULE};
			const found = await getGoogleCookies({ requiredCookies: ["__Secure-1PSID", "__Secure-1PSIDTS"] });
			process.stdout.write(JSON.stringify(found));`,
			{ NODE_OPTIONS: "--input-type=module" },
		);
		assert.deepEqual(outcome, { read: { cookies: FIXTURE_COOKIES, warnings: [] }, preloadRuns: 1 });
	},
);

test.runIf(process.platform === "linux")(
	"getGoogleCookies reads no cookie database when the process disables node:sqlite (#6079)",
	() => {
		const outcome = readCookiesInChild(
			["--no-experimental-sqlite"],
			`(async () => {
				const { getGoogleCookies } = await import(${COOKIES_MODULE});
				process.stdout.write(JSON.stringify(await getGoogleCookies()));
			})();`,
		);
		assert.deepEqual(outcome, { read: null, preloadRuns: 0 });
	},
);
