import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runIntercomCommand } from "../../packages/coding-agent/src/cli/intercom-command.js";
import { parseStorageCommand, runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { isTeamProfileConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	checkSharedStorageAdapter,
	collectStorageStatus,
	type DomainStatus,
	type StorageStatus,
} from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

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

test("storage migrate initializes sessions and Intercom without the workflow runtime", async () => {
	const path = join(root, "shared.sqlite");
	writeSettings({
		storage: { adapter: resolve(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"), options: { path } },
	});
	const result = await storage(["migrate"]);
	assert.equal(result.code, 0, result.err);
	const database = await openNodeSqliteDatabase(path);
	try {
		const tables = (await database.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name);
		assert.ok(tables.includes("session_sessions"));
		assert.ok(tables.includes("intercom_known_sessions"));
		// Shared-history forks turned on by themselves, with no older Atomic running a session there (#6560).
		assert.ok(tables.includes("session_fork_segments"));
		assert.equal((await database.get("SELECT schema_version FROM session_meta"))?.schema_version, 3);
	} finally {
		await database.close();
	}
});

test("storage migrate creates the Intercom tables a broker otherwise creates only on first use (#6560)", async () => {
	const path = join(root, "lazy.sqlite");
	writeSettings({
		storage: { adapter: resolve(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"), options: { path } },
	});
	const result = await storage(["migrate"]);
	assert.equal(result.code, 0, result.err);
	const database = await openNodeSqliteDatabase(path);
	try {
		const objects = new Set(
			(await database.all("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")).map((row) => row.name),
		);
		for (const name of [
			"intercom_ended_child_queue",
			"intercom_ended_child_queue_home",
			"intercom_ended_child_queue_departure",
			"intercom_ended_child_bodies",
			"intercom_ended_child_wakes",
			"intercom_ended_child_wakes_home",
			"intercom_ended_child_meta",
		])
			assert.ok(objects.has(name), `${name} is missing after migrate`);
	} finally {
		await database.close();
	}
});

describe("atomic storage and atomic intercom arguments", () => {
	test("parse the storage subcommands and their options (#3857)", () => {
		assert.deepEqual(parseStorageCommand([]), { kind: "help" });
		assert.deepEqual(parseStorageCommand(["status", "--help"]), { kind: "help" });
		assert.deepEqual(parseStorageCommand(["status"]), { kind: "status", json: false });
		assert.deepEqual(parseStorageCommand(["status", "--json"]), { kind: "status", json: true });
		assert.deepEqual(
			parseStorageCommand([
				"join",
				"postgres://atomic@db.example.com/atomic",
				"--password-file",
				"password",
				"--prefix",
				"team_",
			]),
			{ kind: "join", url: "postgres://atomic@db.example.com/atomic", passwordFile: "password", prefix: "team_" },
		);
	});

	test("reject storage arguments that would join the wrong way (#3857)", () => {
		const rejects = (args: string[], code: string, field: string) =>
			assert.throws(
				() => parseStorageCommand(args),
				(error: Error) => isTeamProfileConfigError(error) && error.code === code && error.field === field,
			);
		rejects(["join", "postgres://atomic@db.example.com/atomic"], "missing-token", "--password-file");
		rejects(["join", "mysql://db", "--token-file", "t"], "unsupported-url", "<url>");
		assert.throws(() => parseStorageCommand(["join"]), /Usage: .* storage join <url>/);
		assert.throws(
			() => parseStorageCommand(["join", "postgres://atomic@db.example.com/atomic", "--token-file"]),
			/--token-file needs a value/,
		);
		assert.throws(() => parseStorageCommand(["status", "--prefix", "x"]), /Unknown option --prefix/);
		assert.throws(() => parseStorageCommand(["doctor"]), /Unknown storage command "doctor"/);
	});

	test("join and migrate refuse every libSQL URL, saying libSQL was removed and how to move sessions off it", () => {
		for (const url of [
			"libsql://db.example.turso.io",
			"https://db.example.turso.io",
			"http://127.0.0.1:8080",
			"wss://db.example.turso.io",
			"file:/tmp/shared.sqlite",
			"file:./shared.sqlite",
		]) {
			for (const args of [
				["join", url, "--token-file", "token"],
				["join", url],
				["migrate", "--db", url, "--token-file", "token"],
			]) {
				assert.throws(
					() => parseStorageCommand(args),
					(error: Error) => {
						assert.ok(isTeamProfileConfigError(error), error.message);
						assert.equal(error.code, "libsql-removed");
						assert.equal(error.field, "<url>");
						assert.match(error.message, /libSQL support .* was removed in Atomic 0\.10\.11/);
						assert.match(error.message, /storage export .* storage import/);
						assert.match(error.message, /https:\/\/docs\.bastani\.ai\/storage#moving-off-libsql/);
						return true;
					},
					args.join(" "),
				);
			}
		}
	});

	test("intercom accepts only status, restart and upgrade (#3857, #4538)", async () => {
		const help = await run((log, error) => runIntercomCommand(["--help"], { agentDir, log, error }));
		assert.equal(help.code, 0);
		assert.match(help.out, /intercom restart/);
		assert.match(help.out, /intercom upgrade/);
		const extraUpgrade = await run((log, error) => runIntercomCommand(["upgrade", "now"], { agentDir, log, error }));
		assert.equal(extraUpgrade.code, 1);
		assert.equal(extraUpgrade.err, "Usage: atomic intercom upgrade");
		const unknown = await run((log, error) => runIntercomCommand(["stop"], { agentDir, log, error }));
		assert.equal(unknown.code, 1);
		assert.match(unknown.err, /Unknown intercom command "stop"/);
		const extra = await run((log, error) => runIntercomCommand(["restart", "now"], { agentDir, log, error }));
		assert.equal(extra.code, 1);
		assert.equal(extra.err, "Usage: atomic intercom restart");
		const extraStatus = await run((log, error) => runIntercomCommand(["status", "now"], { agentDir, log, error }));
		assert.deepEqual([extraStatus.code, extraStatus.err], [1, "Usage: atomic intercom status"]);
	});
});

describe("storage status sources (#3856)", () => {
	test("global settings select every domain, and an empty agent directory selects the defaults", async () => {
		const empty = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(empty), { sessions: "default", intercom: "default" });
		assert.equal(domain(empty, "sessions").selection, `SQLite ${join(agentDir, "workflows", "journal.sqlite")}`);
		assert.match(domain(empty, "intercom").multiNode ?? "", /^off: no shared storage selection/);

		writeSettings({ storage: { path: "shared.sqlite", prefix: "t_" } });
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
		assert.deepEqual(sources(status), {
			sessions: "global settings: storage",
			intercom: "global settings: storage",
		});
		assert.equal(domain(status, "sessions").selection, `SQLite ${join(agentDir, "shared.sqlite")} (prefix t_)`);
		assert.equal(domain(status, "sessions").probe?.connection.status, "skipped");
		assert.match(domain(status, "sessions").probe?.connection.detail ?? "", /not created yet/);
		assert.equal(domain(status, "intercom").probe?.sameAs, "sessions");
		assert.match(domain(status, "intercom").multiNode ?? "", /^on \(a local SQLite file/);
	});

	test("each domain variable outranks settings, and ATOMIC_STORAGE outranks only settings", async () => {
		writeSettings({
			storage: { path: "shared.sqlite" },
			sessions: { storage: { path: "sessions.sqlite" } },
		});
		const settingsOnly = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(settingsOnly), {
			sessions: "global settings: sessions.storage",
			intercom: "global settings: storage",
		});
		assert.deepEqual(domain(settingsOnly, "sessions").overridden, ["global settings: storage"]);

		vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ path: join(root, "env.sqlite") }));
		const shared = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(shared), {
			sessions: "ATOMIC_STORAGE",
			intercom: "ATOMIC_STORAGE",
		});
		assert.equal(domain(shared, "intercom").selection, `SQLite ${join(root, "env.sqlite")}`);
		assert.deepEqual(domain(shared, "sessions").overridden, [
			"global settings: sessions.storage",
			"global settings: storage",
		]);

		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify({ dir: join(root, "sessions") }));
		const domains = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(domains), {
			sessions: "ATOMIC_SESSIONS_STORAGE",
			intercom: "ATOMIC_STORAGE",
		});
		assert.equal(domain(domains, "sessions").selection, `JSONL directory ${join(root, "sessions")}`);

		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", "");
		vi.stubEnv("ATOMIC_CODING_AGENT_SESSION_DIR", join(root, "legacy-sessions"));
		const legacy = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.equal(domain(legacy, "sessions").source, "ATOMIC_CODING_AGENT_SESSION_DIR");
	});

	test("conflicting variables are reported as an invalid selection, not a fallback", async () => {
		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify({ path: "a.sqlite" }));
		vi.stubEnv("ATOMIC_CODING_AGENT_SESSION_DIR", join(root, "b"));
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.equal(domain(status, "sessions").selection, "invalid");
		assert.match(domain(status, "sessions").error ?? "", /conflicting-overrides/);
	});

	test("the workflow journal variables of earlier releases select nothing, even when invalid or conflicting", async () => {
		vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", "{ not json");
		vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "b.sqlite"));
		writeSettings({ workflows: { journal: { path: "journal.sqlite" } } });
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
		assert.deepEqual(
			status.domains.map((entry) => entry.domain),
			["sessions", "intercom"],
		);
		assert.deepEqual(sources(status), { sessions: "default", intercom: "default" });
		assert.equal(domain(status, "sessions").error, undefined);
		const result = await storage(["status"]);
		assert.equal(result.code, 0, result.err);
		assert.doesNotMatch(result.out, /Workflow runs|journal store/);
	});

	test("trusted project settings select sessions but never Intercom", async () => {
		writeSettings({ storage: { path: "global.sqlite" } });
		writeProjectSettings({ storage: { path: join(root, "project.sqlite") } }, true);
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(sources(status), {
			sessions: "project settings: storage",
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
		assert.match(result.out, /Intercom: SQLite .*existing\.sqlite\n[\s\S]*connection: {2}ok \(node-sqlite/);
		assert.doesNotMatch(result.out, /Workflow runs/);
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

	test("a database that does not answer fails status with its connection failure (#4325)", async () => {
		const path = join(root, "garbage.sqlite");
		writeFileSync(path, "this is not a SQLite database, although it is longer than a database header would be");
		writeSettings({ storage: { path } });
		const result = await storage(["status", "--json"]);
		assert.equal(result.code, 1);
		const status: StorageStatus = JSON.parse(result.out);
		assert.equal(domain(status, "sessions").probe?.connection.status, "failed");
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
		assert.equal(
			restart.out,
			"No Intercom broker is running. The next session that uses Intercom starts one with the current storage selection.",
		);
		const upgrade = await run((log, error) => runIntercomCommand(["upgrade"], { agentDir, log, error }));
		assert.equal(upgrade.code, 0, upgrade.err);
		assert.equal(
			upgrade.out,
			"No Intercom broker is running. The next session that uses Intercom starts this version's broker.",
		);
	});
});
