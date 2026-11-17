import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdirSync } from "node:fs";
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

test("getGoogleCookies reads and decrypts Chromium cookies via worker thread without blocking", async () => {
	if (process.platform !== "linux" && process.platform !== "darwin") return;

	const home = makeTempDirectory("chrome-cookies-home-");
	vi.stubEnv("HOME", home);
	try {
		const baseDir =
			process.platform === "darwin" ? "Library/Application Support/net.imput.helium" : ".config/chromium";
		const cookiesPath = join(home, baseDir, "Default", "Cookies");
		mkdirSync(dirname(cookiesPath), { recursive: true });

		const db = new DatabaseSync(cookiesPath);
		try {
			db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER)");
			db.exec(
				"CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, encrypted_value BLOB, expires_utc INTEGER)",
			);
			db.prepare("INSERT INTO meta (key, value) VALUES ('version', 24)").run();

			const iterations = process.platform === "darwin" ? 1003 : 1;
			const encryptedSid = encryptChromiumCookie("decrypted-psid", "peanuts", iterations, true);
			db.prepare(
				"INSERT INTO cookies (name, value, host_key, encrypted_value, expires_utc) VALUES (?, ?, ?, ?, ?)",
			).run("__Secure-1PSID", "", ".google.com", encryptedSid, 100);
			db.prepare(
				"INSERT INTO cookies (name, value, host_key, encrypted_value, expires_utc) VALUES (?, ?, ?, ?, ?)",
			).run("__Secure-1PSIDTS", "plain-psidts", "gemini.google.com", new Uint8Array(0), 200);
		} finally {
			db.close();
		}

		if (process.platform === "linux") {
			const result = await getGoogleCookies({
				requiredCookies: ["__Secure-1PSID", "__Secure-1PSIDTS"],
			});
			assert.ok(result);
			assert.equal(result.cookies["__Secure-1PSID"], "decrypted-psid");
			assert.equal(result.cookies["__Secure-1PSIDTS"], "plain-psidts");
		}
	} finally {
		removeTempDirectory(home);
	}
});
