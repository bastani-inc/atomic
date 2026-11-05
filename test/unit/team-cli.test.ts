import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runTeamCommand } from "../../packages/coding-agent/src/cli/team-command.js";
import {
	type IntercomBrokerControl,
	loadIntercomBrokerControl,
} from "../../packages/coding-agent/src/core/intercom-broker-control.js";
import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import { FileSettingsStorage } from "../../packages/coding-agent/src/core/settings-storage.js";
import {
	isRetryableTeamProfileError,
	isTeamProfileConfigError,
	isTeamProfileError,
	isTeamProfileTimeoutError,
	TeamProfileError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	getTeamProfile,
	joinTeam,
	LIBSQL_ADAPTER_PACKAGE,
	LOCAL_SESSIONS_STORAGE,
	leaveTeam,
	STORAGE_TOKEN_FILE,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import {
	collectStorageStatus,
	type StorageStatus,
} from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { joinTeamWith } from "../../packages/coding-agent/src/core/storage/team.js";
import { selectRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
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
	"ATOMIC_PROFILE",
	"ATOMIC_TEAM_URL",
	"ATOMIC_TEAM_TOKEN",
	"ATOMIC_TEAM_TOKEN_FILE",
	"ATOMIC_TEAM_PREFIX",
];
const UNRELATED = {
	theme: "dark",
	retry: { enabled: false, provider: { maxRetryDelayMs: 1000 } },
	workflows: { localWorkers: { workers: 2 } },
};

let root: string;
let agentDir: string;
let project: string;
let databaseDirectory: string;
let databaseUrl: string;
let tokenFile: string;
let restarts: string[];

beforeEach(async () => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("team-cli-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	databaseDirectory = makeLibsqlDirectory();
	const path = join(databaseDirectory, "team.sqlite");
	databaseUrl = pathToFileURL(path).href;
	const database = await openNodeSqliteDatabase(path);
	await database.exec("CREATE TABLE existing (id INTEGER PRIMARY KEY)");
	await database.close();
	tokenFile = join(root, "turso-token");
	writeFileSync(tokenFile, "  team-secret-token\n");
	restarts = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await removeLibsqlDirectory(databaseDirectory);
	removeTempDirectory(root);
});

function writeSettings(settings: object): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

function settingsText(): string {
	return readFileSync(join(agentDir, "settings.json"), "utf8");
}

function savedSettings(): Record<string, object> {
	return JSON.parse(settingsText());
}

function tokenFiles(): string[] {
	return readdirSync(agentDir).filter((name) => name.startsWith(`${STORAGE_TOKEN_FILE}.`));
}

/** The bundled broker control, recording each restart it is asked for. */
async function recordingControl(): Promise<IntercomBrokerControl> {
	const control = await loadIntercomBrokerControl();
	return {
		...control,
		restartIntercomBroker: (directory, options) => {
			restarts.push(directory);
			return control.restartIntercomBroker(directory, options);
		},
	};
}

async function team(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runTeamCommand(args, {
		cwd: project,
		agentDir,
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		loadControl: recordingControl,
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("atomic team join, status and leave (#4320)", () => {
	test(
		"join pins sessions to the local store, shares workflow runs and Intercom, restarts the broker and prints the status (#4320)",
		async () => {
			writeSettings({ ...UNRELATED, packages: [packageRoot] });
			const joined = await team(["join", databaseUrl, "--token-file", tokenFile, "--prefix", "team_"]);
			assert.equal(joined.code, 0, joined.err);

			const saved = savedSettings();
			const reference = (saved.storage as { secrets: { authToken: { file: string } } }).secrets.authToken.file;
			assert.match(reference, /^agent\/storage-token\.[\da-f-]+$/);
			assert.deepEqual(saved, {
				...UNRELATED,
				packages: [packageRoot],
				storage: {
					adapter: LIBSQL_ADAPTER_PACKAGE,
					options: { url: databaseUrl },
					secrets: { authToken: { file: reference } },
					prefix: "team_",
				},
				sessions: { storage: LOCAL_SESSIONS_STORAGE },
			});
			const tokenPath = resolve(root, reference);
			assert.equal(readFileSync(tokenPath, "utf8"), "team-secret-token");
			if (process.platform !== "win32") assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
			assert.deepEqual(restarts, [agentDir]);
			assert.doesNotMatch(`${joined.out}\n${joined.err}`, /team-secret-token/);
			assert.match(joined.out, /^No Intercom broker was running/m);
			assert.match(
				joined.out,
				/^Profile: team \(sessions on this machine; workflow runs and Intercom on the team database\)$/m,
			);
			assert.match(
				joined.out,
				new RegExp(
					`^Sessions: SQLite ${join(root, "workflows", "journal.sqlite").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`,
					"m",
				),
			);
			assert.match(joined.out, /^ {2}source: {6}global settings: sessions\.storage$/m);
			assert.match(joined.out, /^Workflow runs: adapter @bastani\/atomic-storage-libsql \(prefix team_\)$/m);
			assert.match(joined.out, /^Intercom: adapter @bastani\/atomic-storage-libsql \(prefix team_\)$/m);
			assert.match(joined.out, /^ {2}multi-node: {2}on$/m);
			assert.match(joined.out, /^Intercom group: sessions in .* join "project:project"/m);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"sessions stay local after join while workflow runs and Intercom use the team database (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project });
			const settings = savedSettings();
			assert.deepEqual(selectSessionStorage(project, { agentDir, settings }), {
				kind: "sqlite",
				path: join(root, "workflows", "journal.sqlite"),
			});
			const journal = selectRunJournal({ agentDir, settings });
			assert.ok("kind" in journal && journal.kind === "adapter");
			assert.equal(journal.module, LIBSQL_ADAPTER_PACKAGE);
			const status = await collectStorageStatus({ cwd: project, agentDir, probe: false });
			const intercom = status.domains.find((domain) => domain.domain === "intercom");
			assert.equal(intercom?.selection, `adapter ${LIBSQL_ADAPTER_PACKAGE}`);
			assert.equal(intercom?.source, "global settings: storage");
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"join, status and leave are idempotent and leave unrelated settings untouched (#4320)",
		async () => {
			writeSettings({ ...UNRELATED, packages: [packageRoot] });
			const before = settingsText();
			assert.equal((await getTeamProfile({ agentDir, cwd: project })).profile, "individual");

			assert.equal((await team(["join", databaseUrl, "--token-file", tokenFile])).code, 0);
			const joinedOnce = settingsText();
			const secondJoin = await team(["join", databaseUrl, "--token-file", tokenFile]);
			assert.equal(secondJoin.code, 0, secondJoin.err);
			assert.match(secondJoin.out, /^Kept the token in .*; it already holds this token\.$/m);
			assert.equal(settingsText(), joinedOnce);
			assert.equal(tokenFiles().length, 1);

			const status = await team(["status", "--json"]);
			const again = await team(["status", "--json"]);
			assert.equal(status.code, 0, status.err);
			const parsed: StorageStatus & { profile: { profile: string }; projectGroup: string } = JSON.parse(status.out);
			assert.equal(parsed.profile.profile, "team");
			assert.equal(parsed.projectGroup, "project:project");
			assert.equal(JSON.parse(again.out).profile.profile, "team");
			assert.equal(settingsText(), joinedOnce);

			const left = await team(["leave"]);
			assert.equal(left.code, 0, left.err);
			assert.match(left.out, /^Removed `storage` and `sessions\.storage` from .*; other settings are unchanged\.$/m);
			assert.match(left.out, /^Deleted the token file /m);
			assert.match(left.out, /^Profile: individual /m);
			assert.deepEqual(JSON.parse(settingsText()), JSON.parse(before));
			assert.deepEqual(tokenFiles(), []);
			const leftAgain = await team(["leave"]);
			assert.equal(leftAgain.code, 0, leftAgain.err);
			assert.match(leftAgain.out, /^Nothing to remove: /m);
			assert.deepEqual(JSON.parse(settingsText()), JSON.parse(before));
			assert.deepEqual(restarts, [agentDir, agentDir, agentDir]);
			assert.equal((await getTeamProfile({ agentDir, cwd: project })).profile, "individual");
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"leave keeps a token file another setting still references and values join did not write (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			const joined = await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project });
			assert.ok(joined.tokenPath);
			const settings = savedSettings();
			writeSettings({ ...settings, workflows: { journal: settings.storage } });
			const left = await leaveTeam({ agentDir, cwd: project });
			assert.deepEqual(left.removed, ["storage", "sessions.storage"]);
			assert.deepEqual(left.keptTokenFiles, [joined.tokenPath]);
			assert.deepEqual(left.deletedTokenFiles, []);
			assert.equal(existsSync(joined.tokenPath), true);
			assert.deepEqual(savedSettings(), { packages: [packageRoot], workflows: { journal: settings.storage } });

			const custom = {
				packages: [packageRoot],
				storage: { adapter: LIBSQL_ADAPTER_PACKAGE, options: { url: databaseUrl, tls: false } },
				sessions: { storage: { path: "elsewhere.sqlite" } },
			};
			writeSettings(custom);
			const kept = await leaveTeam({ agentDir, cwd: project });
			assert.deepEqual(kept.removed, []);
			assert.deepEqual(kept.kept, [
				{ key: "storage", reason: "changed" },
				{ key: "sessions.storage", reason: "changed" },
			]);
			assert.equal(kept.broker, undefined);
			assert.deepEqual(savedSettings(), custom);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"leave keeps the local sessions pin while an edited storage remains, so private sessions never move (#4320)",
		async () => {
			vi.stubEnv("TEAM_TOKEN", "team-secret-token");
			const localSessions = { kind: "sqlite", path: join(root, "workflows", "journal.sqlite") };
			for (const edit of [
				(storage: { secrets?: object }) => ({ ...storage, secrets: { authToken: { env: "TEAM_TOKEN" } } }),
				() => ({ path: "shared.sqlite" }),
			]) {
				writeSettings({ packages: [packageRoot] });
				const joined = await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project });
				assert.ok(joined.tokenPath);
				const settings = savedSettings();
				writeSettings({ ...settings, storage: edit(settings.storage as { secrets?: object }) });
				const before = settingsText();
				const profile = (await getTeamProfile({ agentDir, cwd: project })).profile;
				const left = await leaveTeam({ agentDir, cwd: project });
				assert.deepEqual(left.removed, []);
				assert.deepEqual(left.kept, [
					{ key: "storage", reason: "changed" },
					{ key: "sessions.storage", reason: "storage-remains" },
				]);
				assert.equal(left.broker, undefined);
				assert.equal(settingsText(), before);
				assert.deepEqual(selectSessionStorage(project, { agentDir }), localSessions);
				assert.equal(existsSync(joined.tokenPath), true);
				assert.equal((await getTeamProfile({ agentDir, cwd: project })).profile, profile);
			}
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"join reports a sessions.storage it replaces with the local pin (#4320)",
		async () => {
			const cases: [object, string | undefined][] = [
				[LOCAL_SESSIONS_STORAGE, undefined],
				[{ dir: "sessions" }, `JSONL directory ${join(root, "sessions")}`],
				[{ path: "mine.sqlite", prefix: "me_" }, `SQLite ${join(root, "mine.sqlite")} (prefix me_)`],
				[{ adapter: "@example/sessions", options: { url: "x" } }, "adapter @example/sessions"],
				[{ path: 7 }, "an invalid selection"],
			];
			for (const [pin, replaced] of cases) {
				writeSettings({ packages: [packageRoot], sessions: { storage: pin } });
				const joined = await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project });
				assert.equal(joined.replacedSessionsStorage, replaced, JSON.stringify(pin));
				assert.deepEqual(savedSettings().sessions, { storage: LOCAL_SESSIONS_STORAGE });
			}
			writeSettings({ packages: [packageRoot] });
			const fresh = await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project });
			assert.equal(Object.hasOwn(fresh, "replacedSessionsStorage"), false);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a literal SDK token is stored only in the private token file, never in settings, output or errors (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			const joined = await joinTeam({ url: databaseUrl, token: " literal-secret-token ", agentDir, cwd: project });
			assert.equal(joined.token, "new");
			assert.ok(joined.tokenPath);
			assert.equal(readFileSync(joined.tokenPath, "utf8"), "literal-secret-token");
			assert.doesNotMatch(settingsText(), /literal-secret-token/);
			assert.doesNotMatch(JSON.stringify(joined), /literal-secret-token/);
			const missing = pathToFileURL(join(databaseDirectory, "absent", "dir", "db.sqlite")).href;
			const failure = await joinTeam({ url: missing, token: "literal-secret-token", agentDir, cwd: project }).then(
				() => assert.fail("joining an unreachable database succeeded"),
				(error: Error) => error,
			);
			assert.ok(isTeamProfileError(failure));
			assert.equal(failure.code, "connection-failed");
			assert.equal(failure.retryable, true);
			assert.ok(isRetryableTeamProfileError(new Error("wrapped", { cause: failure })));
			assert.doesNotMatch(`${failure.message}\n${JSON.stringify(failure)}`, /literal-secret-token/);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test("join changes nothing when an input or a precondition fails (#4320)", async () => {
		const before = { ...UNRELATED };
		writeSettings(before);
		const notInstalled = await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project }).then(
			() => assert.fail("joined without the adapter"),
			(error: Error) => error,
		);
		assert.ok(notInstalled instanceof TeamProfileError);
		assert.deepEqual([notInstalled.code, notInstalled.retryable], ["adapter-not-installed", false]);
		assert.match(notInstalled.hint, /atomic install npm:@bastani\/atomic-storage-libsql/);
		assert.deepEqual(savedSettings(), before);
		assert.deepEqual(tokenFiles(), []);

		writeFileSync(join(agentDir, "settings.json"), '{ "theme": "dark", ');
		const unreadable = await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project }).then(
			() => assert.fail("joined with unreadable settings"),
			(error: Error) => error,
		);
		assert.ok(isTeamProfileError(unreadable));
		assert.equal(unreadable.code, "settings-unreadable");
		assert.equal(unreadable.subject, join(agentDir, "settings.json"));
		assert.ok(unreadable.cause instanceof Error);
		assert.equal(settingsText(), '{ "theme": "dark", ');

		const invalid = await joinTeam({ url: "file:relative.sqlite", agentDir, cwd: project }).then(
			() => assert.fail("joined a relative file URL"),
			(error: Error) => error,
		);
		assert.ok(isTeamProfileConfigError(invalid));
		assert.deepEqual([invalid.source, invalid.field, invalid.code], ["sdk", "url", "relative-file-url"]);
	});

	test(
		"a settings write failure keeps the previous selection and removes only the new token file (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot], theme: "dark" });
			const before = settingsText();
			vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock").mockImplementation(() => {
				throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
			});
			const failure = await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project }).then(
				() => assert.fail("joined although settings could not be written"),
				(error: Error) => error,
			);
			assert.ok(isTeamProfileError(failure));
			assert.deepEqual([failure.code, failure.retryable], ["settings-write-failed", false]);
			assert.equal(failure.detail, "ENOSPC: no space left on device, write");
			assert.equal(settingsText(), before);
			assert.deepEqual(tokenFiles(), []);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a broker that cannot restart is reported after the settings are saved (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			const out: string[] = [];
			const err: string[] = [];
			const code = await runTeamCommand(["join", databaseUrl, "--token-file", tokenFile], {
				cwd: project,
				agentDir,
				log: (line) => out.push(line),
				error: (line) => err.push(line),
				loadControl: () => Promise.reject(new Error("control unavailable")),
			});
			assert.equal(code, 1);
			assert.equal(
				err.join("\n"),
				`Could not restart the Intercom broker: ${agentDir} (broker-restart-failed): control unavailable. The settings are saved. Run \`atomic intercom restart\` so the broker uses them.`,
			);
			assert.deepEqual(savedSettings().sessions, { storage: LOCAL_SESSIONS_STORAGE });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a settings lock held by another process is a retryable error, and nothing changes (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			const before = settingsText();
			const release = lockfile.lockSync(join(agentDir, "settings.json"), { realpath: false });
			try {
				const failure = await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project }).then(
					() => assert.fail("joined while another process held the settings lock"),
					(error: Error) => error,
				);
				assert.ok(isTeamProfileError(failure));
				assert.deepEqual([failure.code, failure.retryable], ["settings-locked", true]);
				assert.equal(
					failure.hint,
					"Nothing was changed. Run the command again in a few seconds; a lock left by a killed process expires after 10 seconds.",
				);
				assert.equal(failure.subject, join(agentDir, "settings.json"));
				assert.equal(settingsText(), before);
				assert.deepEqual(tokenFiles(), []);
			} finally {
				release();
			}
			assert.equal((await joinTeam({ url: databaseUrl, tokenFile, agentDir, cwd: project })).token, "new");
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a database that never answers fails the join with a typed timeout, and nothing changes (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			const before = settingsText();
			const silent = createServer(() => {});
			await new Promise<void>((listening) => silent.listen(0, "127.0.0.1", listening));
			const { port } = silent.address() as AddressInfo;
			try {
				const url = `https://127.0.0.1:${port}`;
				const failure = await joinTeamWith({ url, tokenFile, agentDir, cwd: project }, "sdk", {
					connectionTimeoutMs: 300,
				}).then(
					() => assert.fail("joined a database that never answered"),
					(error: Error) => error,
				);
				assert.ok(isTeamProfileTimeoutError(failure));
				assert.ok(isTeamProfileError(failure));
				assert.ok(failure instanceof TeamProfileError);
				assert.deepEqual(
					[failure.name, failure.code, failure.retryable, failure.timeoutMs, failure.phase, failure.subject],
					["TeamProfileTimeoutError", "connection-timeout", true, 300, "connect", url],
				);
				assert.equal(
					failure.message,
					`The team database did not answer in time: ${url} (connection-timeout): no answer within 300 ms (connect). Nothing was changed. Check that the database is reachable from this machine, then run the command again.`,
				);
				assert.equal(settingsText(), before);
				assert.deepEqual(tokenFiles(), []);
			} finally {
				silent.close();
			}
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test("leave reports a token file it cannot delete after removing the team settings (#4320)", async () => {
		const tokenDirectory = join(agentDir, `${STORAGE_TOKEN_FILE}.not-a-file`);
		mkdirSync(tokenDirectory);
		writeFileSync(join(tokenDirectory, "inside"), "x");
		writeSettings({
			storage: {
				adapter: LIBSQL_ADAPTER_PACKAGE,
				options: { url: "libsql://team.example.turso.io" },
				secrets: { authToken: { file: `agent/${STORAGE_TOKEN_FILE}.not-a-file` } },
			},
			sessions: { storage: LOCAL_SESSIONS_STORAGE },
		});
		const failure = await leaveTeam({ agentDir, cwd: project }).then(
			() => assert.fail("left without reporting the token file"),
			(error: Error) => error,
		);
		assert.ok(isTeamProfileError(failure));
		assert.deepEqual([failure.code, failure.subject], ["token-delete-failed", tokenDirectory]);
		assert.equal(failure.hint, "The team settings were removed. Delete the token file yourself.");
		assert.deepEqual(savedSettings(), {});
	});

	test("team arguments are checked before anything runs (#4320)", async () => {
		const cases: [string[], string, string][] = [
			[["doctor"], "unknown-command", "<command>"],
			[["join"], "missing-url", "<url>"],
			[["join", databaseUrl, "extra"], "unexpected-argument", "arguments after <url>"],
			[["join", databaseUrl, "--token-file"], "missing-value", "--token-file"],
			[["join", databaseUrl, "--token=secret-in-flag"], "unknown-option", "--token"],
			[["leave", "now"], "unexpected-argument", "arguments after leave"],
		];
		for (const [args, code, field] of cases) {
			const result = await team(args);
			assert.equal(result.code, 1, args.join(" "));
			assert.match(result.err, new RegExp(`\\(${code}\\)`), args.join(" "));
			assert.ok(result.err.includes(`: ${field} (`), result.err);
			assert.doesNotMatch(result.err, /secret-in-flag/);
		}
		assert.equal(
			(await team(["join", databaseUrl, "extra"])).err,
			'Invalid team command: arguments after <url> (unexpected-argument). Pass one URL. Use "atomic team --help" for usage.',
		);
		const help = await team(["--help"]);
		assert.equal(help.code, 0);
		assert.match(help.out, /atomic team join <url>/);
		assert.equal(existsSync(join(agentDir, "settings.json")), false);
	});
});
