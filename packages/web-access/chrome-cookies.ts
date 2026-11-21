import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2 } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { createChildProcessEnvironment } from "@bastani/atomic";
import { pathExists } from "./path-exists.js";

const pbkdf2Async = promisify(pbkdf2);

export type CookieMap = Record<string, string>;

interface BrowserConfig {
	name: string;
	baseDir: string;
	keychainService?: string;
	keychainAccount?: string;
	secretToolApp?: string;
}

const GOOGLE_ORIGINS = [
	"https://gemini.google.com",
	"https://accounts.google.com",
	"https://www.google.com",
];

const ALL_COOKIE_NAMES = new Set([
	"__Secure-1PSID",
	"__Secure-1PSIDTS",
	"__Secure-1PSIDCC",
	"__Secure-1PAPISID",
	"NID",
	"AEC",
	"SOCS",
	"__Secure-BUCKET",
	"__Secure-ENID",
	"SID",
	"HSID",
	"SSID",
	"APISID",
	"SAPISID",
	"__Secure-3PSID",
	"__Secure-3PSIDTS",
	"__Secure-3PAPISID",
	"SIDCC",
]);

const MACOS_BROWSER_CONFIGS: BrowserConfig[] = [
	{
		name: "Helium",
		baseDir: "Library/Application Support/net.imput.helium",
		keychainService: "Helium Storage Key",
		keychainAccount: "Helium",
	},
	{
		name: "Chrome",
		baseDir: "Library/Application Support/Google/Chrome",
		keychainService: "Chrome Safe Storage",
		keychainAccount: "Chrome",
	},
	{
		name: "Arc",
		baseDir: "Library/Application Support/Arc/User Data",
		keychainService: "Arc Safe Storage",
		keychainAccount: "Arc",
	},
];

const LINUX_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium" },
	{ name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome" },
];

export async function getGoogleCookies(
	options?: { profile?: string; requiredCookies?: string[] },
): Promise<{ cookies: CookieMap; warnings: string[] } | null> {
	const currentPlatform = platform();
	const configs = currentPlatform === "darwin"
		? MACOS_BROWSER_CONFIGS
		: currentPlatform === "linux"
			? LINUX_BROWSER_CONFIGS
			: [];
	if (configs.length === 0) return null;

	const warnings: string[] = [];
	const profile = options?.profile ?? "Default";
	const hosts = GOOGLE_ORIGINS.map((origin) => new URL(origin).hostname);

	for (const config of configs) {
		const cookiesPath = join(homedir(), config.baseDir, profile, "Cookies");
		if (!(await pathExists(cookiesPath))) continue;

		const password = await readBrowserPassword(config, currentPlatform);
		if (!password) {
			warnings.push(`Could not read ${config.name} cookie encryption password`);
			continue;
		}

		const key = await pbkdf2Async(password, "saltysalt", currentPlatform === "darwin" ? 1003 : 1, 16, "sha1");
		const tempDir = await mkdtemp(join(tmpdir(), "pi-chrome-cookies-"));

		try {
			const tempDb = join(tempDir, "Cookies");
			await copyFile(cookiesPath, tempDb);
			await copySidecar(cookiesPath, tempDb, "-wal");
			await copySidecar(cookiesPath, tempDb, "-shm");

			const { metaVersion, rows } = await readCookieDatabase(tempDb, hosts);
			const stripHash = metaVersion >= 24;
			if (!rows) {
				warnings.push(`Failed to query ${config.name} cookie database`);
				continue;
			}

			const cookies: CookieMap = {};
			for (const row of rows) {
				const name = row.name as string;
				if (!ALL_COOKIE_NAMES.has(name)) continue;
				if (cookies[name]) continue;

				let value = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
				if (!value) {
					const encrypted = row.encrypted_value;
					if (encrypted instanceof Uint8Array) {
						value = decryptCookieValue(encrypted, key, stripHash);
					}
				}
				if (value) cookies[name] = value;
			}

			if (options?.requiredCookies?.length && !options.requiredCookies.every((name) => Boolean(cookies[name]))) {
				continue;
			}

			return { cookies, warnings };
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	return null;
}

function decryptCookieValue(encrypted: Uint8Array, key: Buffer, stripHash: boolean): string | null {
	const buf = Buffer.from(encrypted);
	if (buf.length < 3) return null;

	const prefix = buf.subarray(0, 3).toString("utf8");
	if (!/^v\d\d$/.test(prefix)) return null;

	const ciphertext = buf.subarray(3);
	if (!ciphertext.length) return "";

	try {
		const iv = Buffer.alloc(16, 0x20);
		const decipher = createDecipheriv("aes-128-cbc", key, iv);
		decipher.setAutoPadding(false);
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		const unpadded = removePkcs7Padding(plaintext);
		const bytes = stripHash && unpadded.length >= 32 ? unpadded.subarray(32) : unpadded;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		let i = 0;
		while (i < decoded.length && decoded.charCodeAt(i) < 0x20) i++;
		return decoded.slice(i);
	} catch {
		return null;
	}
}

function removePkcs7Padding(buf: Buffer): Buffer {
	if (!buf.length) return buf;
	const padding = buf[buf.length - 1];
	if (!padding || padding > 16) return buf;
	return buf.subarray(0, buf.length - padding);
}

function readBrowserPassword(
	config: BrowserConfig,
	currentPlatform: ReturnType<typeof platform>,
): Promise<string | null> {
	if (currentPlatform === "darwin") {
		if (!config.keychainAccount || !config.keychainService) return Promise.resolve(null);
		return readKeychainPassword(config.keychainAccount, config.keychainService);
	}
	if (currentPlatform === "linux") {
		return readLinuxPassword(config.secretToolApp);
	}
	return Promise.resolve(null);
}

function readKeychainPassword(account: string, service: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"security",
			["find-generic-password", "-w", "-a", account, "-s", service],
			{ timeout: 5000, env: createChildProcessEnvironment() },
			(err, stdout) => {
				if (err) { resolve(null); return; }
				resolve(stdout.trim() || null);
			},
		);
	});
}

function readLinuxPassword(secretToolApp: string | undefined): Promise<string> {
	if (!secretToolApp) return Promise.resolve("peanuts");

	return new Promise((resolve) => {
		execFile(
			"secret-tool",
			["lookup", "application", secretToolApp],
			{ timeout: 5000, env: createChildProcessEnvironment() },
			(err, stdout) => {
				if (err) {
					// KDE Wallet users fall through to peanuts intentionally.
					resolve("peanuts");
					return;
				}
				resolve(stdout.trim() || "peanuts");
			},
		);
	});
}

interface CookieDatabaseResult {
	metaVersion: number;
	rows: Array<Record<string, unknown>> | null;
}

// Node evaluates this source as an ES module, which has no require, when --input-type=module reaches the worker (from
// NODE_OPTIONS, or the process's flags under the permission model) (#6110); `builtin` loads Node's modules either way.
const COOKIE_SQLITE_WORKER_SOURCE = `
const builtin = typeof require === "function" ? require : (id) => process.getBuiltinModule(id);
const { parentPort, workerData } = builtin("node:worker_threads");

const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
	const msg = typeof warning === "string" ? warning : warning?.message ?? "";
	if (msg.includes("SQLite is an experimental feature")) return;
	return origEmitWarning(warning, ...args);
};

function supportsReadBigInts() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major > 24) return true;
	if (major < 24) return false;
	return minor >= 4;
}

function readMetaVersion(sqlite, dbPath, opts) {
	const db = new sqlite.DatabaseSync(dbPath, opts);
	try {
		const rows = db.prepare("SELECT value FROM meta WHERE key = 'version'").all();
		const val = rows[0]?.value;
		if (typeof val === "number") return Math.floor(val);
		if (typeof val === "bigint") return Number(val);
		if (typeof val === "string") return Number.parseInt(val, 10) || 0;
		return 0;
	} catch {
		return 0;
	} finally {
		db.close();
	}
}

function queryCookieRows(sqlite, dbPath, where, opts) {
	const db = new sqlite.DatabaseSync(dbPath, opts);
	try {
		return db
			.prepare(
				"SELECT name, value, host_key, encrypted_value FROM cookies WHERE (" +
					where +
					") ORDER BY expires_utc DESC",
			)
			.all();
	} catch {
		return null;
	} finally {
		db.close();
	}
}

let sqlite = null;
try {
	sqlite = builtin("node:sqlite");
} catch {
	sqlite = null;
}

if (!sqlite) {
	parentPort?.postMessage({ metaVersion: 0, rows: null });
} else {
	const opts = { readOnly: true };
	if (supportsReadBigInts()) opts.readBigInts = true;
	let metaVersion = 0;
	try {
		metaVersion = readMetaVersion(sqlite, workerData.dbPath, opts);
	} catch {
		metaVersion = 0;
	}
	let rows = null;
	try {
		rows = queryCookieRows(sqlite, workerData.dbPath, workerData.where, opts);
	} catch {
		rows = null;
	}
	parentPort?.postMessage({ metaVersion, rows });
}
`;

function buildHostWhereClause(hosts: string[]): string {
	const clauses: string[] = [];
	for (const host of hosts) {
		for (const candidate of expandHosts(host)) {
			const esc = candidate.replaceAll("'", "''");
			clauses.push(`host_key = '${esc}'`);
			clauses.push(`host_key = '.${esc}'`);
			clauses.push(`host_key LIKE '%.${esc}'`);
		}
	}
	return clauses.join(" OR ");
}

function readCookieDatabase(dbPath: string, hosts: string[]): Promise<CookieDatabaseResult> {
	// Asked on this thread, without loading the module: the worker starts without the process's flags, so a
	// `--no-experimental-sqlite` given to the process would not reach it.
	if (!isBuiltin("node:sqlite")) return Promise.resolve({ metaVersion: 0, rows: null });
	const where = buildHostWhereClause(hosts);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: CookieDatabaseResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		try {
			const worker = new Worker(COOKIE_SQLITE_WORKER_SOURCE, {
				eval: true,
				// None of the process's flags: the process's preloads would run again in the worker, and its
				// `--input-type=module` would make the source a module. Under Node's permission model a worker is
				// restricted only by the flags it starts with, so there it keeps them.
				execArgv: process.permission === undefined ? [] : undefined,
				workerData: { dbPath, where },
			});
			worker.once("message", (msg: unknown) => {
				if (msg && typeof msg === "object") {
					const data = msg as { metaVersion?: unknown; rows?: unknown };
					finish({
						metaVersion: typeof data.metaVersion === "number" ? data.metaVersion : 0,
						rows: Array.isArray(data.rows) ? (data.rows as Array<Record<string, unknown>>) : null,
					});
					return;
				}
				finish({ metaVersion: 0, rows: null });
			});
			worker.once("error", () => finish({ metaVersion: 0, rows: null }));
			worker.once("exit", () => finish({ metaVersion: 0, rows: null }));
		} catch {
			finish({ metaVersion: 0, rows: null });
		}
	});
}

function expandHosts(host: string): string[] {
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 1) return [host];
	const candidates = new Set<string>();
	candidates.add(host);
	for (let i = 1; i <= parts.length - 2; i++) {
		const c = parts.slice(i).join(".");
		if (c) candidates.add(c);
	}
	return Array.from(candidates);
}


async function copySidecar(srcDb: string, targetDb: string, suffix: string): Promise<void> {
	const sidecar = `${srcDb}${suffix}`;
	try {
		await copyFile(sidecar, `${targetDb}${suffix}`);
	} catch {}
}
