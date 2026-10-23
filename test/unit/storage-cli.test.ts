import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runIntercomCommand } from "../../packages/coding-agent/src/cli/intercom-command.js";
import {
	LIBSQL_ADAPTER_PACKAGE,
	parseStorageCommand,
	runStorageCommand,
	STORAGE_TOKEN_FILE,
} from "../../packages/coding-agent/src/cli/storage-command.js";
import { FileSettingsStorage } from "../../packages/coding-agent/src/core/settings-storage.js";
import {
	checkSharedStorageAdapter,
	collectStorageStatus,
	type DomainStatus,
	type StorageStatus,
} from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

/** Loading the libSQL package adapter through jiti and opening a `file:` database. */
const LIBSQL_SCENARIO_TIMEOUT_MS = 60_000;

const packageRoot = resolve(moduleDir(import.meta.url), "../../packages/storage-libsql");
const STORAGE_VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
];

let root: string;
let agentDir: string;
let project: string;

beforeEach(() => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("storage-cli-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function writeSettings(settings: object): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

function writeProjectSettings(settings: object, trusted: boolean): void {
	mkdirSync(join(project, ".atomic"), { recursive: true });
	writeFileSync(join(project, ".atomic", "settings.json"), JSON.stringify(settings));
	new ProjectTrustStore(agentDir).set(project, trusted);
}

function domain(status: StorageStatus, name: DomainStatus["domain"]): DomainStatus {
	const found = status.domains.find((entry) => entry.domain === name);
	assert.ok(found, `no ${name} domain`);
	return found;
}

function sources(status: StorageStatus): Record<string, string> {
	return Object.fromEntries(status.domains.map((entry) => [entry.domain, entry.source]));
}

async function run(
	command: (log: (line: string) => void, error: (line: string) => void) => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await command(
		(line) => out.push(line),
		(line) => err.push(line),
	);
	return { code, out: out.join("\n"), err: err.join("\n") };
}

function storage(args: string[]) {
	return run((log, error) => runStorageCommand(args, { cwd: project, agentDir, log, error }));
}

describe("atomic storage and atomic intercom arguments", () => {
	test("parse the storage subcommands and their options (#3857)", () => {
		assert.deepEqual(parseStorageCommand([]), { kind: "help" });
		assert.deepEqual(parseStorageCommand(["status", "--help"]), { kind: "help" });
		assert.deepEqual(parseStorageCommand(["status"]), { kind: "status", json: false });
		assert.deepEqual(parseStorageCommand(["status", "--json"]), { kind: "status", json: true });
		assert.deepEqual(
			parseStorageCommand(["join", "libsql://db.example.turso.io", "--token-file", "token", "--prefix", "team_"]),
			{ kind: "join", url: "libsql://db.example.turso.io", tokenFile: "token", prefix: "team_" },
		);
		assert.deepEqual(parseStorageCommand(["join", "file:/tmp/shared.sqlite"]), {
			kind: "join",
			url: "file:/tmp/shared.sqlite",
		});
	});

	test("reject storage arguments that would join the wrong way (#3857)", () => {
		assert.throws(() => parseStorageCommand(["join", "libsql://db.example.turso.io"]), /--token-file is required/);
		assert.throws(
			() => parseStorageCommand(["join", "postgres://db", "--token-file", "t"]),
			/Unsupported database URL/,
		);
		assert.throws(() => parseStorageCommand(["join"]), /Usage: .* storage join <url>/);
		assert.throws(() => parseStorageCommand(["join", "file:/x", "--token-file"]), /--token-file needs a value/);
		assert.throws(() => parseStorageCommand(["status", "--prefix", "x"]), /Unknown option --prefix/);
		assert.throws(() => parseStorageCommand(["doctor"]), /Unknown storage command "doctor"/);
	});

	test("join refuses a database URL that carries the token, so it never reaches settings or the output (#3857)", () => {
		for (const url of [
			"libsql://db.example.turso.io?authToken=secret",
			"libsql://db.example.turso.io/?x=1&authToken=secret",
			"libsql://user:secret@db.example.turso.io",
			"https://secret@db.example.turso.io",
		]) {
			assert.throws(
				() => parseStorageCommand(["join", url, "--token-file", "token"]),
				(error: Error) => {
					assert.match(error.message, /carries a credential.*--token-file/);
					assert.doesNotMatch(error.message, /secret/);
					return true;
				},
				url,
			);
		}
		assert.deepEqual(parseStorageCommand(["join", "libsql://db.example.turso.io/?tls=0", "--token-file", "token"]), {
			kind: "join",
			url: "libsql://db.example.turso.io/?tls=0",
			tokenFile: "token",
		});
	});

	test("intercom accepts only status and restart (#3857)", async () => {
		const help = await run((log, error) => runIntercomCommand(["--help"], { agentDir, log, error }));
		assert.equal(help.code, 0);
		assert.match(help.out, /intercom restart/);
		const unknown = await run((log, error) => runIntercomCommand(["stop"], { agentDir, log, error }));
		assert.equal(unknown.code, 1);
		assert.match(unknown.err, /Unknown intercom command "stop"/);
		const extra = await run((log, error) => runIntercomCommand(["restart", "now"], { agentDir, log, error }));
		assert.equal(extra.code, 1);
	});
});

describe("storage status sources (#3856)", () => {
	test("global settings select every domain, and an empty agent directory selects the defaults", async () => {
		const empty = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(empty), { sessions: "default", journal: "default", intercom: "default" });
		assert.equal(domain(empty, "sessions").selection, `SQLite ${join(root, "workflows", "journal.sqlite")}`);
		assert.match(domain(empty, "intercom").multiNode ?? "", /^off: no shared storage selection/);

		writeSettings({ storage: { path: "shared.sqlite", prefix: "t_" } });
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
		assert.deepEqual(sources(status), {
			sessions: "global settings: storage",
			journal: "global settings: storage",
			intercom: "global settings: storage",
		});
		assert.equal(domain(status, "journal").selection, `SQLite ${join(root, "shared.sqlite")} (prefix t_)`);
		assert.equal(domain(status, "sessions").probe?.connection.status, "skipped");
		assert.match(domain(status, "sessions").probe?.connection.detail ?? "", /not created yet/);
		assert.equal(domain(status, "journal").probe?.sameAs, "sessions");
		assert.match(domain(status, "intercom").multiNode ?? "", /^on \(a local SQLite file/);
	});

	test("each domain variable outranks settings, and ATOMIC_STORAGE outranks only settings", async () => {
		writeSettings({
			storage: { path: "shared.sqlite" },
			sessions: { storage: { path: "sessions.sqlite" } },
			workflows: { journal: { path: "journal.sqlite" } },
		});
		const settingsOnly = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(settingsOnly), {
			sessions: "global settings: sessions.storage",
			journal: "global settings: workflows.journal",
			intercom: "global settings: storage",
		});
		assert.deepEqual(domain(settingsOnly, "sessions").overridden, ["global settings: storage"]);

		vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ path: join(root, "env.sqlite") }));
		const shared = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(shared), {
			sessions: "ATOMIC_STORAGE",
			journal: "ATOMIC_STORAGE",
			intercom: "ATOMIC_STORAGE",
		});
		assert.equal(domain(shared, "intercom").selection, `SQLite ${join(root, "env.sqlite")}`);
		assert.deepEqual(domain(shared, "journal").overridden, [
			"global settings: workflows.journal",
			"global settings: storage",
		]);

		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify({ dir: join(root, "sessions") }));
		vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "legacy-journal.sqlite"));
		const domains = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(domains), {
			sessions: "ATOMIC_SESSIONS_STORAGE",
			journal: "ATOMIC_WORKFLOW_JOURNAL_PATH",
			intercom: "ATOMIC_STORAGE",
		});
		assert.equal(domain(domains, "sessions").selection, `JSONL directory ${join(root, "sessions")}`);
		assert.equal(domain(domains, "journal").selection, `SQLite ${join(root, "legacy-journal.sqlite")}`);

		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", "");
		vi.stubEnv("ATOMIC_CODING_AGENT_SESSION_DIR", join(root, "legacy-sessions"));
		const legacy = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.equal(domain(legacy, "sessions").source, "ATOMIC_CODING_AGENT_SESSION_DIR");
	});

	test("conflicting variables are reported as an invalid selection, not a fallback", async () => {
		vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", JSON.stringify({ path: "a.sqlite" }));
		vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "b.sqlite"));
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.equal(domain(status, "journal").selection, "invalid");
		assert.match(domain(status, "journal").error ?? "", /conflicting-overrides/);
	});

	test("trusted project settings select sessions and workflow runs but never Intercom", async () => {
		writeSettings({ storage: { path: "global.sqlite" } });
		writeProjectSettings({ storage: { path: join(root, "project.sqlite") } }, true);
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(status), {
			sessions: "project settings: storage",
			journal: "project settings: storage",
			intercom: "global settings: storage",
		});
		assert.deepEqual(domain(status, "sessions").overridden, ["global settings: storage"]);
		assert.ok(status.notes.some((note) => /which Intercom ignores/.test(note)));
	});

	test("untrusted project settings are reported and not applied", async () => {
		writeProjectSettings({ storage: { path: join(root, "project.sqlite") } }, false);
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.equal(status.projectTrusted, false);
		assert.equal(domain(status, "sessions").source, "default");
		assert.ok(status.notes.some((note) => /not trusted/.test(note)));
	});
});

describe("storage status checks", () => {
	test("status reports malformed settings instead of silently probing defaults (#3856)", async () => {
		writeFileSync(join(agentDir, "settings.json"), '{ "storage": ');
		const result = await storage(["status"]);
		assert.equal(result.code, 1);
		assert.match(result.err, /Cannot load.*global.*settings/i);
		assert.equal(result.out, "");
	});

	test("status never creates a missing libSQL file database (#3856)", async () => {
		const path = join(root, "missing-libsql.sqlite");
		writeSettings({
			packages: [packageRoot],
			storage: { adapter: LIBSQL_ADAPTER_PACKAGE, options: { url: pathToFileURL(path).href } },
		});
		const result = await storage(["status", "--json"]);
		assert.equal(result.code, 0, result.err);
		assert.equal(existsSync(path), false);
		const status: StorageStatus = JSON.parse(result.out);
		assert.equal(domain(status, "sessions").probe?.adapter?.loaded, true);
		assert.equal(domain(status, "sessions").probe?.connection.status, "skipped");
		assert.match(domain(status, "sessions").probe?.connection.detail ?? "", /file not found/);
	});

	test("status leaves a DELETE-journal SQLite file byte-for-byte unchanged (#3856)", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const path = join(root, "delete-journal.sqlite");
		const database = new DatabaseSync(path);
		database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE notes (id INTEGER PRIMARY KEY)");
		database.close();
		const before = readFileSync(path);
		writeSettings({ storage: { path } });
		const result = await storage(["status"]);
		assert.equal(result.code, 0, result.err);
		assert.deepEqual(readFileSync(path), before);
	});

	test("a local SQLite selection answers a SELECT 1 and keeps its tables unchanged (#3856)", async () => {
		const path = join(root, "existing.sqlite");
		const database = await openNodeSqliteDatabase(path);
		await database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
		await database.close();
		writeSettings({ storage: { path } });

		const result = await storage(["status"]);
		assert.equal(result.code, 0, result.err);
		assert.match(result.out, /Sessions: SQLite .*existing\.sqlite/);
		assert.match(result.out, /connection: {2}ok \(node-sqlite .*existing\.sqlite answered in \d+ ms\)/);
		assert.match(result.out, /Workflow runs: SQLite[\s\S]*connection: {2}same as sessions/);
		assert.match(result.out, /Intercom broker: not running/);
		assert.match(result.out, /multi-node: {2}on \(a local SQLite file[^\n]*\n {2}brokers: {5}0 live in the database/);

		const reopened = await openNodeSqliteDatabase(path);
		try {
			assert.deepEqual(await reopened.all("SELECT name FROM sqlite_master WHERE type = 'table'"), [
				{ name: "notes" },
			]);
		} finally {
			await reopened.close();
		}
	});

	test("an adapter that cannot load fails status with its cause and the launch check warns (#3856)", async () => {
		writeSettings({ storage: { adapter: "./missing-adapter.ts" } });
		const result = await storage(["status", "--json"]);
		assert.equal(result.code, 1);
		const status: StorageStatus = JSON.parse(result.out);
		assert.equal(domain(status, "intercom").probe?.adapter?.loaded, false);
		assert.equal(domain(status, "intercom").multiNode, "off: the adapter cannot be loaded");

		const warning = await checkSharedStorageAdapter(agentDir, { adapter: "./missing-adapter.ts" });
		assert.match(
			warning ?? "",
			/Storage adapter "\.\/missing-adapter\.ts" cannot be loaded by this Atomic \([^)]+\): Cannot find module '\.\/missing-adapter\.ts'\. /,
		);
		assert.doesNotMatch(warning ?? "", /Require stack/);
		// The packaged libSQL adapter loads, so a correctly installed selection is not warned about.
		writeSettings({ packages: [packageRoot] });
		assert.equal(await checkSharedStorageAdapter(agentDir, { adapter: LIBSQL_ADAPTER_PACKAGE }), undefined);
		assert.match(warning ?? "", /Intercom multi-node routing stays off/);
		assert.equal(await checkSharedStorageAdapter(agentDir, { path: "x.sqlite" }), undefined);
		assert.equal(await checkSharedStorageAdapter(agentDir, undefined), undefined);
		vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ adapter: "./also-missing.ts" }));
		assert.match((await checkSharedStorageAdapter(agentDir, undefined)) ?? "", /"\.\/also-missing\.ts"/);
	});

	test("intercom status and restart report no running broker for an idle agent directory (#3857)", async () => {
		const status = await run((log, error) => runIntercomCommand(["status"], { agentDir, log, error }));
		assert.equal(status.code, 0, status.err);
		assert.match(status.out, /Intercom broker: not running/);
		const restart = await run((log, error) => runIntercomCommand(["restart"], { agentDir, log, error }));
		assert.equal(restart.code, 0, restart.err);
		assert.match(restart.out, /No Intercom broker is running/);
	});
});

describe("atomic storage join with the libSQL package (#3857)", () => {
	let databaseDirectory: string;
	let databaseUrl: string;
	let tokenFile: string;

	beforeEach(async () => {
		databaseDirectory = makeLibsqlDirectory();
		const path = join(databaseDirectory, "shared.sqlite");
		databaseUrl = pathToFileURL(path).href;
		const database = await openNodeSqliteDatabase(path);
		await database.exec("CREATE TABLE existing (id INTEGER PRIMARY KEY)");
		await database.close();
		tokenFile = join(root, "turso-token");
		writeFileSync(tokenFile, "  secret-token\n\n");
	});

	afterEach(async () => {
		await removeLibsqlDirectory(databaseDirectory);
	});

	async function tables(): Promise<{ name: string }[]> {
		const database = await openNodeSqliteDatabase(join(databaseDirectory, "shared.sqlite"));
		try {
			return await database.all<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			);
		} finally {
			await database.close();
		}
	}

	test("prints the install command and changes nothing when the package is not installed", async () => {
		writeSettings({ theme: "dark" });
		const result = await storage(["join", databaseUrl, "--token-file", tokenFile]);
		assert.equal(result.code, 1);
		assert.match(result.err, new RegExp(`atomic install npm:${LIBSQL_ADAPTER_PACKAGE.replace("/", "\\/")}`));
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")), { theme: "dark" });
		assert.throws(() => statSync(join(agentDir, STORAGE_TOKEN_FILE)), { code: "ENOENT" });
	});

	test("a malformed global settings file reports the settings error instead of a missing adapter, and stays as it was (#3857)", async () => {
		const malformed = '{ "theme": "dark", ';
		writeFileSync(join(agentDir, "settings.json"), malformed);
		const result = await storage(["join", databaseUrl, "--token-file", tokenFile]);
		assert.equal(result.code, 1);
		assert.match(result.err, /Cannot update the global settings/);
		assert.match(result.err, /Fix .*settings\.json first/);
		assert.doesNotMatch(result.err, /not installed/);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), malformed);
		assert.throws(() => statSync(join(agentDir, STORAGE_TOKEN_FILE)), { code: "ENOENT" });
	});

	test("join rejects relative file URLs before checking or saving them (#3857)", async () => {
		writeSettings({ packages: [packageRoot] });
		const before = readFileSync(join(agentDir, "settings.json"), "utf8");
		const result = await storage(["join", "file:./shared.sqlite"]);
		assert.equal(result.code, 1);
		assert.match(result.err, /absolute file: URL/);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
	});

	test("a settings write failure preserves the previous token and leaves settings intact (#3857)", async () => {
		writeSettings({
			packages: [packageRoot],
			storage: {
				adapter: LIBSQL_ADAPTER_PACKAGE,
				options: { url: "file:old.sqlite" },
				secrets: { authToken: { file: `agent/${STORAGE_TOKEN_FILE}` } },
			},
		});
		const settingsBefore = readFileSync(join(agentDir, "settings.json"), "utf8");
		const tokenPath = join(agentDir, STORAGE_TOKEN_FILE);
		writeFileSync(tokenPath, "previous-token", { mode: 0o600 });
		vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock").mockImplementation(() => {
			throw new Error("settings write denied");
		});
		const result = await storage(["join", databaseUrl, "--token-file", tokenFile]);
		assert.equal(result.code, 1);
		assert.match(result.err, /settings write denied/);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), settingsBefore);
		assert.equal(readFileSync(tokenPath, "utf8"), "previous-token");
		assert.deepEqual(
			readdirSync(agentDir).filter((name) => name.startsWith(STORAGE_TOKEN_FILE)),
			[STORAGE_TOKEN_FILE],
		);
	});

	test("join reports success after saving even if project diagnostics cannot load (#3857)", async () => {
		writeSettings({ packages: [packageRoot] });
		writeProjectSettings({}, true);
		writeFileSync(join(project, ".atomic", "settings.json"), '{ "storage": ');
		const result = await storage(["join", databaseUrl, "--token-file", tokenFile]);
		assert.equal(result.code, 0, result.err);
		assert.match(result.out, /saved.*could not report.*project settings/i);
		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.equal(saved.storage.options.url, databaseUrl);
		assert.equal(readFileSync(resolve(root, saved.storage.secrets.authToken.file), "utf8"), "secret-token");
	});

	test(
		"stores the trimmed token privately, writes only `storage`, creates no tables, and reports overrides",
		async () => {
			const other = {
				theme: "dark",
				packages: [packageRoot],
				sessions: { storage: { path: "sessions.sqlite" } },
				retry: { enabled: false, provider: { maxRetryDelayMs: 1000 } },
			};
			writeSettings(other);
			writeProjectSettings({ storage: { path: join(root, "project.sqlite") } }, true);
			vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", JSON.stringify({ path: join(root, "env-journal.sqlite") }));
			const before = await tables();

			const result = await storage(["join", databaseUrl, "--token-file", tokenFile, "--prefix", "team_"]);
			assert.equal(result.code, 0, result.err);

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			const tokenReference: string = saved.storage.secrets.authToken.file;
			assert.match(tokenReference, /^agent\/storage-token\.[\da-f-]+$/);
			const tokenPath = resolve(root, tokenReference);
			assert.equal(readFileSync(tokenPath, "utf8"), "secret-token");
			if (process.platform !== "win32") assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
			assert.equal(readFileSync(tokenFile, "utf8"), "  secret-token\n\n");
			assert.deepEqual(saved, {
				...other,
				storage: {
					adapter: LIBSQL_ADAPTER_PACKAGE,
					options: { url: databaseUrl },
					secrets: { authToken: { file: tokenReference } },
					prefix: "team_",
				},
			});
			assert.deepEqual(await tables(), before);
			assert.match(result.out, /Sessions: global settings: sessions\.storage/);
			assert.match(result.out, /Workflow runs: ATOMIC_WORKFLOWS_JOURNAL/);
			assert.match(result.out, /which Intercom ignores/);
			assert.doesNotMatch(result.out, /secret-token/);

			vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", "");
			const status = await storage(["status", "--json"]);
			const parsed: StorageStatus = JSON.parse(status.out);
			assert.equal(domain(parsed, "intercom").source, "global settings: storage");
			assert.equal(domain(parsed, "intercom").probe?.connection.status, "ok");
			assert.equal(domain(parsed, "intercom").multiNode, "on");
			assert.deepEqual(await tables(), before);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"an empty token or an unreachable database leaves settings and token untouched",
		async () => {
			writeSettings({ packages: [packageRoot] });
			writeFileSync(tokenFile, " \n");
			const empty = await storage(["join", databaseUrl, "--token-file", tokenFile]);
			assert.equal(empty.code, 1);
			assert.match(empty.err, /is empty/);

			writeFileSync(tokenFile, "token\n");
			const missing = pathToFileURL(join(databaseDirectory, "absent", "dir", "db.sqlite")).href;
			const unreachable = await storage(["join", missing, "--token-file", tokenFile]);
			assert.equal(unreachable.code, 1);
			assert.match(unreachable.err, /Could not connect to .*Nothing was changed/);
			assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")), {
				packages: [packageRoot],
			});
			assert.throws(() => statSync(join(agentDir, STORAGE_TOKEN_FILE)), { code: "ENOENT" });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});
