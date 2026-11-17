import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import { getGoogleCookies } from "../../packages/web-access/chrome-cookies.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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

test.runIf(process.platform === "linux")(
	"getGoogleCookies decrypts Chromium cookies without querying SQLite on the main thread (#5377)",
	async () => {
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
		vi.stubEnv("HOME", home);
		vi.stubEnv("PATH", binDir);
		try {
			const cookiesPath = join(home, ".config/chromium", "Default", "Cookies");
			mkdirSync(dirname(cookiesPath), { recursive: true });

			const db = new DatabaseSync(cookiesPath);
			try {
				db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER)");
				db.exec(
					"CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, encrypted_value BLOB, expires_utc INTEGER)",
				);
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
