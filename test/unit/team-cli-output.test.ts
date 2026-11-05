import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { parseTeamCommand, runTeamCommand } from "../../packages/coding-agent/src/cli/team-command.js";
import type {
	IntercomBrokerControl,
	RestartOutcome,
} from "../../packages/coding-agent/src/core/intercom-broker-control.js";
import {
	LIBSQL_ADAPTER_PACKAGE,
	LOCAL_SESSIONS_STORAGE,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

/** Loading the libSQL package adapter through jiti and opening a `file:` database. */
const LIBSQL_SCENARIO_TIMEOUT_MS = 60_000;
const packageRoot = resolve(moduleDir(import.meta.url), "../../packages/storage-libsql");
const VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_PROFILE",
	"ATOMIC_TEAM_URL",
	"ATOMIC_TEAM_TOKEN",
	"ATOMIC_TEAM_TOKEN_FILE",
	"ATOMIC_TEAM_PREFIX",
];

let root: string;
let agentDir: string;
let project: string;
let databaseDirectory: string;
let databaseUrl: string;
let tokenFile: string;
let restarts: string[];

beforeEach(async () => {
	for (const name of VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("team-transcript-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	databaseDirectory = makeLibsqlDirectory();
	const path = join(databaseDirectory, "team.sqlite");
	databaseUrl = pathToFileURL(path).href;
	await (await openNodeSqliteDatabase(path)).close();
	tokenFile = join(root, "token");
	writeFileSync(tokenFile, "transcript-token\n");
	restarts = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await removeLibsqlDirectory(databaseDirectory);
	removeTempDirectory(root);
});

function control(outcome: RestartOutcome | Error, projectGroup?: string): IntercomBrokerControl {
	return {
		queryIntercomBroker: async () => ({ state: "stopped" }),
		expectedBrokerStorage: () => undefined,
		readLiveBrokers: async () => [],
		restartIntercomBroker: async (directory, options) => {
			restarts.push(directory);
			options?.onProgress?.("Stopping the Intercom broker (pid 101)");
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		describeMultiNodeStatus: () => "on",
		projectHomeGroup: (cwd, directory) => (cwd === project && directory === agentDir ? projectGroup : "wrong"),
	};
}

async function team(
	args: string[],
	broker: IntercomBrokerControl | undefined,
): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runTeamCommand(args, {
		cwd: project,
		agentDir,
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		...(broker === undefined ? {} : { loadControl: async () => broker }),
	});
	const normalize = (text: string) =>
		text
			.replaceAll(root, "<root>")
			.replace(/storage-token\.[\da-f-]+/g, "storage-token.<id>")
			.replace(/answered in \d+ ms/g, "answered in <n> ms");
	return { code, out: normalize(out.join("\n")), err: normalize(err.join("\n")) };
}

function writeSettings(settings: object): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

describe("atomic team output (#4320)", () => {
	test("parses every command and option exactly (#4320)", () => {
		for (const args of [[], ["help"], ["--help"], ["status", "-h"], ["leave", "--help"]]) {
			assert.deepEqual(parseTeamCommand(args), { kind: "help" }, args.join(" "));
		}
		assert.deepEqual(parseTeamCommand(["status"]), { kind: "status", json: false });
		assert.deepEqual(parseTeamCommand(["status", "--json"]), { kind: "status", json: true });
		assert.deepEqual(parseTeamCommand(["leave"]), { kind: "leave" });
		assert.deepEqual(parseTeamCommand(["join", "libsql://db"]), { kind: "join", url: "libsql://db" });
		assert.deepEqual(parseTeamCommand(["join", "--prefix", "t_", "libsql://db", "--token-file", "f"]), {
			kind: "join",
			url: "libsql://db",
			tokenFile: "f",
			prefix: "t_",
		});
		const rejects = (args: string[], message: string) =>
			assert.throws(
				() => parseTeamCommand(args),
				(error: Error) => error.message === message,
				args.join(" "),
			);
		rejects(
			["doctor"],
			'Invalid team command: <command> (unknown-command). Use join, status or leave. Use "atomic team --help" for usage.',
		);
		rejects(
			["status", "--prefix", "x"],
			'Invalid team command: --prefix (unknown-option). "atomic team status" does not take it. Use "atomic team --help" for usage.',
		);
		rejects(
			["leave", "--json"],
			'Invalid team command: --json (unknown-option). "atomic team leave" does not take it. Use "atomic team --help" for usage.',
		);
		rejects(
			["join", "libsql://db", "--prefix"],
			"Invalid team command: --prefix (missing-value). Pass a value after --prefix.",
		);
		rejects(
			["join"],
			"Invalid storage configuration: <url> (missing-url). Pass the team database URL: atomic team join <url> [--token-file <path>] [--prefix <prefix>]",
		);
		rejects(
			["status", "now"],
			'Invalid team command: arguments after status (unexpected-argument). "atomic team status" takes none. Use "atomic team --help" for usage.',
		);
	});

	test("help goes to standard output by default (#4320)", async () => {
		const printed = vi.spyOn(console, "log").mockImplementation(() => {});
		assert.equal(await runTeamCommand(["--help"], { cwd: project, agentDir }), 0);
		assert.match(String(printed.mock.calls[0]?.[0]), /^Usage:\n {2}atomic team join <url>/);
		const failed = vi.spyOn(console, "error").mockImplementation(() => {});
		assert.equal(await runTeamCommand(["doctor"], { cwd: project, agentDir }), 1);
		assert.match(String(failed.mock.calls[0]?.[0]), /\(unknown-command\)/);
	});

	test(
		"join prints what it wrote, the replaced selection, the restarted broker and the full status (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot], storage: { path: "old.sqlite" } });
			const restarted: RestartOutcome = {
				status: "restarted",
				previous: { pid: 101, sessions: 2 },
				current: {
					state: "running",
					report: { pid: 202, sessions: 2, multiNode: { status: "on" } },
				},
			};
			const result = await team(
				["join", databaseUrl, "--token-file", tokenFile, "--prefix", "team_"],
				control(restarted, "project:acme/alpha"),
			);
			assert.equal(result.err, "");
			assert.equal(result.code, 0);
			const url = databaseUrl.replaceAll(root, "<root>");
			const lines = result.out.split("\n");
			assert.deepEqual(lines.slice(0, 12), [
				"Stopping the Intercom broker (pid 101)",
				`Connected to ${url}.`,
				"Stored the token in <root>/agent/storage-token.<id> (mode 600).",
				"Set `storage` to the team database and `sessions.storage` to the local store in <root>/agent/settings.json; other settings are unchanged.",
				"It replaces the previous selection: SQLite old.sqlite.",
				"Restarted the Intercom broker: pid 101 → 202.",
				"",
				"Profile: team (sessions on this machine; workflow runs and Intercom on the team database)",
				'Intercom group: sessions in <root>/project join "project:acme/alpha" unless ATOMIC_INTERCOM_GROUP or the Intercom config sets a group; sessions that are already running keep theirs until they restart.',
				"",
				"Agent directory: <root>/agent",
				"Project: <root>/project",
			]);
			assert.deepEqual(restarts, [agentDir]);

			const again = await team(
				["join", databaseUrl, "--token-file", tokenFile, "--prefix", "team_"],
				control({
					status: "stopped",
					previous: { pid: 101 },
				}),
			);
			assert.equal(again.code, 0);
			assert.deepEqual(again.out.split("\n").slice(1, 6), [
				`Connected to ${url}.`,
				"Kept the token in <root>/agent/storage-token.<id>; it already holds this token.",
				"Set `storage` to the team database and `sessions.storage` to the local store in <root>/agent/settings.json; other settings are unchanged.",
				"Stopped the Intercom broker (pid 101); the next session that uses Intercom starts one with these settings.",
				"",
			]);
			assert.doesNotMatch(again.out, /It replaces/);
			assert.doesNotMatch(again.out, /Intercom group:/);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"join without a token for a file URL, and a broker whose new pid is unknown (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			const result = await team(
				["join", databaseUrl],
				control({
					status: "restarted",
					previous: { pid: 101 },
					current: { state: "legacy" },
				}),
			);
			assert.equal(result.code, 0, result.err);
			assert.doesNotMatch(result.out, /token/i);
			assert.match(result.out, /^Restarted the Intercom broker: pid 101 → unknown\.$/m);
			const legacy = await team(
				["join", databaseUrl],
				control({
					status: "restarted",
					previous: { pid: 101 },
					current: { state: "legacy", pid: 303 },
				}),
			);
			assert.match(legacy.out, /^Restarted the Intercom broker: pid 101 → 303\.$/m);
			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			assert.deepEqual(saved.storage, { adapter: LIBSQL_ADAPTER_PACKAGE, options: { url: databaseUrl } });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"leave prints every removed, kept and deleted item and the resulting profile (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			assert.equal(
				(await team(["join", databaseUrl, "--token-file", tokenFile], control({ status: "not-running" }))).code,
				0,
			);
			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			writeSettings({ ...settings, workflows: { journal: settings.storage } });
			const left = await team(["leave"], control({ status: "not-running" }));
			assert.equal(left.code, 0, left.err);
			assert.deepEqual(left.out.split("\n"), [
				"Stopping the Intercom broker (pid 101)",
				"Removed `storage` and `sessions.storage` from <root>/agent/settings.json; other settings are unchanged.",
				"Kept the token file <root>/agent/storage-token.<id>: another setting still references it.",
				"No Intercom broker was running; the next session that uses Intercom starts one with these settings.",
				"Profile: custom (matches no preset; see the selections below)",
			]);

			writeSettings({
				packages: [packageRoot],
				storage: { adapter: LIBSQL_ADAPTER_PACKAGE, options: { url: databaseUrl, tls: false } },
				sessions: { storage: LOCAL_SESSIONS_STORAGE },
			});
			const partial = await team(["leave"], control(new Error("never called")));
			assert.equal(partial.code, 0, partial.err);
			assert.deepEqual(partial.out.split("\n"), [
				"Removed `sessions.storage` from <root>/agent/settings.json; other settings are unchanged.",
				"Left `storage` in place: it holds something other than what team join writes.",
				"Profile: ci (sessions, workflow runs and Intercom on the team database)",
			]);
			assert.deepEqual(restarts, [agentDir, agentDir]);

			const none = await team(["leave"], undefined);
			assert.deepEqual(none.out.split("\n"), [
				"Nothing to remove: <root>/agent/settings.json holds no settings that `atomic team join` wrote.",
				"Left `storage` in place: it holds something other than what team join writes.",
				"Profile: ci (sessions, workflow runs and Intercom on the team database)",
			]);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a leave whose broker cannot restart exits 1 after removing the settings (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			await team(["join", databaseUrl, "--token-file", tokenFile], control({ status: "not-running" }));
			const left = await team(["leave"], control(new Error("socket refused")));
			assert.equal(left.code, 1);
			assert.match(
				left.err,
				/^Could not restart the Intercom broker: <root>\/agent \(broker-restart-failed\): socket refused\./,
			);
			assert.match(left.out, /^Deleted the token file <root>\/agent\/storage-token\.<id>\.$/m);
			assert.match(left.out, /^Profile: individual /m);
			assert.deepEqual(
				readdirSync(agentDir).filter((name) => name.startsWith("storage-token.")),
				[],
			);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test("status reports an invalid selection as an unknown profile and exits 1 (#4320)", async () => {
		vi.stubEnv("ATOMIC_STORAGE", "{not json");
		const text = await team(["status"], control({ status: "not-running" }));
		assert.equal(text.code, 1);
		assert.match(text.out, /^Profile: unknown \(Invalid storage configuration: ATOMIC_STORAGE \(invalid-json\)\)$/m);
		assert.doesNotMatch(text.out, /Intercom group:/);
		const json = await team(["status", "--json"], control({ status: "not-running" }));
		assert.equal(json.code, 1);
		const parsed = JSON.parse(json.out);
		assert.equal(parsed.profile, null);
		assert.equal(parsed.profileError, "Invalid storage configuration: ATOMIC_STORAGE (invalid-json)");
		assert.equal(parsed.projectGroup, undefined);
	});

	test("status without a loadable broker control reports the broker as unknown (#4320)", async () => {
		const out: string[] = [];
		const code = await runTeamCommand(["status", "--json"], {
			cwd: project,
			agentDir,
			log: (line) => out.push(line),
			error: () => {},
			loadControl: () => Promise.reject(new Error("intercom package missing")),
		});
		assert.equal(code, 0);
		const parsed = JSON.parse(out.join("\n"));
		assert.deepEqual(parsed.profile, {
			profile: "individual",
			sessions: `SQLite ${join(root, "workflows", "journal.sqlite")}`,
			journal: `SQLite ${join(root, "workflows", "journal.sqlite")}`,
			intercom: "off",
		});
		assert.deepEqual(parsed.broker, { state: "unknown", error: "intercom package missing" });
		assert.equal(parsed.projectGroup, undefined);
	});

	test("an untyped failure is printed as an error and exits 1 (#4320)", async () => {
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), "{ broken");
		new ProjectTrustStore(agentDir).set(project, true);
		const result = await team(["status"], control({ status: "not-running" }));
		assert.equal(result.code, 1);
		assert.match(result.err, /^Error: Cannot load settings: project settings: /);
	});
});
