import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { FileSettingsStorage } from "../../packages/coding-agent/src/core/settings-storage.js";
import {
	isTeamProfileConfigError,
	isTeamProfileError,
	StorageConfigError,
	TeamProfileConfigError,
	TeamProfileError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	checkTeamPrefix,
	checkTeamUrl,
	environmentTeamProfile,
	inMemorySecret,
	LIBSQL_ADAPTER_PACKAGE,
	LOCAL_SESSIONS_STORAGE,
	missingTeamToken,
	REDACTED_SECRET,
	readTeamTokenFile,
	selectStorage,
	teamProfileSelection,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import { selectIntercomStorage } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import {
	assertTeamAdapterInstalled,
	joinSharedDatabase,
	leaveTeamWith,
	selectTeamProfile,
} from "../../packages/coding-agent/src/core/storage/team.js";
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
const noBroker = { loadControl: async () => ({ restartIntercomBroker: async () => ({ status: "not-running" }) }) };

let root: string;
let agentDir: string;
let project: string;
let databaseDirectory: string;
let databaseUrl: string;

beforeEach(async () => {
	for (const name of VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("team-contract-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	databaseDirectory = makeLibsqlDirectory();
	const path = join(databaseDirectory, "team.sqlite");
	databaseUrl = pathToFileURL(path).href;
	await (await openNodeSqliteDatabase(path)).close();
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

function saved(): Record<string, object> {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

function tokenFiles(): string[] {
	return readdirSync(agentDir).filter((name) => name.startsWith("storage-token."));
}

function failure(action: () => unknown): Error {
	try {
		action();
	} catch (error) {
		return error as Error;
	}
	return assert.fail("did not throw");
}

describe("team input checks name the field and the fix (#4320)", () => {
	test("URLs: schemes, file URLs and credentials, with each source's field names (#4320)", () => {
		for (const url of [
			"libsql://db",
			"http://db",
			"https://db",
			"ws://db",
			"wss://db",
			"file:///srv/t.sqlite",
			"file:/srv/t.sqlite",
		]) {
			assert.equal(checkTeamUrl(url, "sdk"), url);
		}
		const unsupported = failure(() => checkTeamUrl("xlibsql://db", "cli"));
		assert.ok(isTeamProfileConfigError(unsupported));
		assert.deepEqual(
			[unsupported.code, unsupported.field, unsupported.hint],
			["unsupported-url", "<url>", "Use a libsql://, https://, wss://, or absolute file: URL."],
		);
		assert.equal(
			(failure(() => checkTeamUrl("libsql:///path", "sdk")) as TeamProfileConfigError).code,
			"unsupported-url",
		);
		const missing = failure(() => checkTeamUrl("", "sdk")) as TeamProfileConfigError;
		assert.deepEqual(
			[missing.code, missing.field, missing.hint],
			["missing-url", "url", "Pass the team database URL, for example libsql://<db>.turso.io."],
		);
		assert.equal((failure(() => checkTeamUrl(undefined, "sdk")) as TeamProfileConfigError).code, "missing-url");
		const hints = (source: "sdk" | "cli" | "env") =>
			(failure(() => checkTeamUrl("https://user@db.example", source)) as TeamProfileConfigError).hint;
		assert.equal(
			hints("cli"),
			"The URL carries a credential (user name, password, or authToken). Remove it and pass the token with --token-file instead, so it never reaches settings or output.",
		);
		assert.match(hints("sdk"), /pass the token with token or tokenFile instead/);
		assert.match(hints("env"), /pass the token with ATOMIC_TEAM_TOKEN or ATOMIC_TEAM_TOKEN_FILE instead/);
		assert.equal(
			(failure(() => checkTeamUrl("https://:pw@db", "sdk")) as TeamProfileConfigError).code,
			"credential-in-url",
		);
		assert.equal(checkTeamUrl("https://db/?token=public", "sdk"), "https://db/?token=public");
		assert.equal(checkTeamUrl("https://[unparsable", "sdk"), "https://[unparsable");
	});

	test("prefixes, token files and missing tokens (#4320)", () => {
		assert.equal(checkTeamPrefix(undefined, "sdk"), undefined);
		assert.equal(checkTeamPrefix("team_", "sdk"), "team_");
		const pattern = failure(() => checkTeamPrefix("9x", "cli")) as TeamProfileConfigError;
		assert.deepEqual(
			[pattern.code, pattern.field, pattern.hint],
			[
				"invalid-prefix",
				"--prefix",
				"Use letters, digits and underscores, not starting with a digit, for example team_.",
			],
		);
		assert.equal((pattern.cause as { reason: string }).reason, "pattern");
		const path = join(root, "absent");
		const unreadable = failure(() => readTeamTokenFile(path, "cli")) as TeamProfileConfigError;
		assert.deepEqual(
			[unreadable.code, unreadable.field, unreadable.path, unreadable.hint],
			["unreadable-token-file", "--token-file", path, `Check that ${path} exists and is readable.`],
		);
		writeFileSync(path, "\n \t\n");
		const empty = failure(() => readTeamTokenFile(path, "sdk")) as TeamProfileConfigError;
		assert.deepEqual(
			[empty.code, empty.field, empty.path, empty.hint],
			[
				"empty-token",
				"tokenFile",
				path,
				`The token file ${path} is empty: write the token into it, for example with turso db tokens create <db>.`,
			],
		);
		writeFileSync(path, "  a.b.c \n");
		assert.equal(readTeamTokenFile(path, "sdk"), "a.b.c");
		assert.deepEqual(
			[missingTeamToken("libsql://db", "cli").field, missingTeamToken("libsql://db", "cli").hint],
			["--token-file", "--token-file is required for libsql: URLs; only absolute file: URLs need no token."],
		);
		assert.deepEqual(
			[missingTeamToken("https://db", "sdk").field, missingTeamToken("https://db", "sdk").hint],
			["token", "Pass the database token for https: URLs; only absolute file: URLs need no token."],
		);
	});

	test("teamProfileSelection hints (#4320)", () => {
		const select = (options: Parameters<typeof teamProfileSelection>[0]) =>
			failure(() => teamProfileSelection(options)) as TeamProfileConfigError;
		assert.equal(select({ profile: "x" as "ci", url: "libsql://db", token: "t" }).hint, 'Pass profile: "ci".');
		const conflict = select({ profile: "ci", url: "libsql://db", token: "t", tokenEnv: "T" });
		assert.deepEqual(
			[conflict.field, conflict.hint],
			["token, tokenFile, tokenEnv", "Pass only one of token, tokenFile, tokenEnv."],
		);
		assert.equal(
			select({ profile: "ci", url: "libsql://db", tokenFile: "a", tokenEnv: "b" }).code,
			"conflicting-token",
		);
		assert.equal(
			select({ profile: "ci", url: "libsql://db", token: "\t" }).hint,
			"token is empty: pass the database token.",
		);
		assert.equal(
			select({ profile: "ci", url: "libsql://db", tokenEnv: "" }).hint,
			"tokenEnv is empty: pass the database token.",
		);
		assert.equal(
			select({ profile: "ci", url: "libsql://db", tokenEnv: "TEAM_DB_TOKEN_UNSET" }).hint,
			"Set TEAM_DB_TOKEN_UNSET to the database token: the selection reads the token from it when the store opens.",
		);
		assert.deepEqual(teamProfileSelection({ profile: "ci", url: "file:///srv/t.sqlite" }), {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: "file:///srv/t.sqlite" },
		});
	});

	test("environment hints name every missing variable (#4320)", () => {
		vi.stubEnv("ATOMIC_PROFILE", "staging");
		assert.equal(
			(failure(() => environmentTeamProfile()) as TeamProfileConfigError).hint,
			"Set ATOMIC_PROFILE to ci, or unset it.",
		);
		vi.stubEnv("ATOMIC_PROFILE", "ci");
		vi.stubEnv("ATOMIC_TEAM_URL", "file:///srv/team.sqlite");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "t");
		assert.deepEqual(environmentTeamProfile(), {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: "file:///srv/team.sqlite" },
			secrets: { authToken: { env: "ATOMIC_TEAM_TOKEN" } },
		});
		vi.stubEnv("ATOMIC_TEAM_URL", "");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "");
		const missing = failure(() => environmentTeamProfile()) as TeamProfileConfigError;
		assert.equal(
			missing.message,
			"Invalid storage configuration: ATOMIC_TEAM_URL, ATOMIC_TEAM_TOKEN or ATOMIC_TEAM_TOKEN_FILE (incomplete-profile). ATOMIC_PROFILE=ci needs the team database URL and its token: set ATOMIC_TEAM_URL and ATOMIC_TEAM_TOKEN or ATOMIC_TEAM_TOKEN_FILE (only an absolute file: URL needs no token).",
		);
		assert.notEqual(missing.missing, undefined);
		vi.stubEnv("ATOMIC_PROFILE", "");
		vi.stubEnv("ATOMIC_TEAM_URL", "libsql://db");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "t");
		const unset = failure(() => environmentTeamProfile()) as TeamProfileConfigError;
		assert.match(
			unset.hint,
			/^ATOMIC_TEAM_URL, ATOMIC_TEAM_TOKEN are set but ATOMIC_PROFILE is not: .* or unset them \(/,
		);
	});
});

describe("secrets in memory stay in memory (#4320)", () => {
	test("an in-memory secret is hidden from inspection, JSON and spreading, even with hidden properties shown (#4320)", () => {
		const secret = inMemorySecret("inspect-secret");
		assert.equal(secret.value, "inspect-secret");
		assert.equal(inspect(secret, { showHidden: true }), `{ value: '${REDACTED_SECRET}' }`);
		assert.equal(JSON.stringify(secret), `{"value":"${REDACTED_SECRET}"}`);
		assert.deepEqual(Object.keys(secret), []);
		const plain = { value: "plain-secret" };
		const selected = selectStorage(
			{ adapter: "x", secrets: { authToken: plain, other: { env: "E" } } },
			"sdk",
			"storage",
			"",
		);
		assert.ok(selected.kind === "adapter");
		const wrapped = selected.secrets?.authToken;
		assert.ok(wrapped !== undefined && "value" in wrapped && wrapped !== plain);
		assert.equal(wrapped.value, "plain-secret");
		assert.equal(JSON.stringify(selected).includes("plain-secret"), false);
		assert.deepEqual(selected.secrets?.other, { env: "E" });
		const already = selectStorage({ adapter: "x", secrets: { authToken: secret } }, "sdk", "storage", "");
		assert.ok(already.kind === "adapter" && already.secrets?.authToken === secret);
	});

	test("every malformed secret reference is a typed config error (#4320)", () => {
		const reason = (secrets: object) =>
			(failure(() => selectStorage({ adapter: "x", secrets } as never, "sdk", "storage", "")) as StorageConfigError)
				.reason;
		assert.equal(reason({ a: null }), "invalid-secret-ref");
		assert.equal(reason({ a: "env" }), "invalid-secret-ref");
		assert.equal(reason({ a: ["env"] }), "invalid-secret-ref");
		assert.equal(reason({ a: {} }), "invalid-secret-ref");
		assert.equal(reason({ a: { env: "E", file: "f" } }), "invalid-secret-ref");
		assert.equal(reason({ a: { env: "E", value: "v" } }), "invalid-secret-ref");
		assert.equal(reason({ a: { value: 7 } }), "invalid-secret-ref");
		assert.equal(reason({ a: { env: 7 } }), "invalid-secret-ref");
		assert.equal(reason({ a: { file: 7 } }), "invalid-secret-ref");
		const fromEnv = failure(() =>
			selectStorage({ adapter: "x", secrets: { a: { value: "v" } } } as never, "env", "ATOMIC_STORAGE", ""),
		) as StorageConfigError;
		assert.deepEqual(
			[fromEnv.source, fromEnv.field, fromEnv.reason],
			["env", "ATOMIC_STORAGE", "in-memory-secret-unsupported"],
		);
	});
});

describe("the Intercom selection follows the broker's rules (#4320)", () => {
	test("in-memory selections are off, relative paths resolve against Atomic home, and the source is named (#4320)", () => {
		assert.equal(selectIntercomStorage(agentDir, undefined), undefined);
		assert.equal(selectIntercomStorage(agentDir, { memory: true }), undefined);
		assert.equal(selectIntercomStorage(agentDir, { path: ":memory:" }), undefined);
		assert.deepEqual(selectIntercomStorage(agentDir, { path: "shared.sqlite" }), {
			kind: "sqlite",
			path: join(root, "shared.sqlite"),
		});
		assert.deepEqual(selectIntercomStorage(agentDir, { path: "" }), {
			kind: "sqlite",
			path: join(root, "storage.sqlite"),
		});
		assert.deepEqual(selectIntercomStorage(agentDir, { path: join(root, "abs.sqlite") }), {
			kind: "sqlite",
			path: join(root, "abs.sqlite"),
		});
		const fromSettings = failure(() =>
			selectIntercomStorage(agentDir, { adapter: "x", options: [] } as never),
		) as StorageConfigError;
		assert.deepEqual([fromSettings.source, fromSettings.field], ["settings", "storage"]);
		vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ adapter: "x", options: { url: 1 }, secrets: { a: "bad" } }));
		const fromEnv = failure(() => selectIntercomStorage(agentDir, undefined)) as StorageConfigError;
		assert.deepEqual([fromEnv.source, fromEnv.field, fromEnv.reason], ["env", "storage", "invalid-secret-ref"]);
	});
});

describe("joining and leaving at the SDK level (#4320)", () => {
	test(
		"a join reports exactly what it wrote and replaced, and reuses only a join-made token file holding the token (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot], storage: { adapter: "./custom-adapter.ts", options: { url: 1 } } });
			const first = await joinSharedDatabase(
				{ url: databaseUrl, token: "sdk-token", prefix: "t_", agentDir, cwd: project, pinLocalSessions: false },
				"sdk",
			);
			const reference = `agent/${tokenFiles()[0]}`;
			assert.deepEqual(first, {
				settingsPath: join(agentDir, "settings.json"),
				storage: {
					adapter: LIBSQL_ADAPTER_PACKAGE,
					options: { url: databaseUrl },
					secrets: { authToken: { file: reference } },
					prefix: "t_",
				},
				tokenPath: join(agentDir, tokenFiles()[0]!),
				token: "new",
				replaced: "adapter ./custom-adapter.ts",
			});
			assert.equal(saved().sessions, undefined);
			const again = await joinSharedDatabase(
				{ url: databaseUrl, token: "sdk-token", prefix: "t_", agentDir, cwd: project, pinLocalSessions: true },
				"sdk",
			);
			assert.equal(again.token, "reused");
			assert.equal(again.replaced, undefined);
			assert.deepEqual(again.sessionsStorage, LOCAL_SESSIONS_STORAGE);
			const rotated = await joinSharedDatabase(
				{ url: databaseUrl, token: "rotated-token", agentDir, cwd: project, pinLocalSessions: true },
				"sdk",
			);
			assert.equal(rotated.token, "new");
			assert.equal(rotated.replaced, `adapter ${LIBSQL_ADAPTER_PACKAGE} (prefix t_)`);
			assert.equal(tokenFiles().length, 2);
			assert.equal(readFileSync(rotated.tokenPath!, "utf8"), "rotated-token");

			writeSettings({
				...saved(),
				storage: { ...saved().storage, secrets: { authToken: { file: "elsewhere/token" } } },
			});
			mkdirSync(join(root, "elsewhere"));
			writeFileSync(join(root, "elsewhere", "token"), "rotated-token");
			assert.equal(
				(
					await joinSharedDatabase(
						{ url: databaseUrl, token: "rotated-token", agentDir, cwd: project, pinLocalSessions: true },
						"sdk",
					)
				).token,
				"new",
			);
			writeSettings({
				...saved(),
				storage: {
					adapter: LIBSQL_ADAPTER_PACKAGE,
					options: { url: databaseUrl },
					secrets: { authToken: { file: "agent/storage-token.gone" } },
				},
			});
			assert.equal(
				(
					await joinSharedDatabase(
						{ url: databaseUrl, token: "rotated-token", agentDir, cwd: project, pinLocalSessions: true },
						"sdk",
					)
				).token,
				"new",
			);
			writeSettings({ ...saved(), storage: { path: 5 } });
			assert.equal(
				(await joinSharedDatabase({ url: databaseUrl, agentDir, cwd: project, pinLocalSessions: true }, "sdk"))
					.replaced,
				"an invalid selection",
			);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test("join input errors come before any read of settings or the network (#4320)", async () => {
		writeFileSync(join(agentDir, "settings.json"), "{ broken");
		const reject = async (options: object, source: "sdk" | "cli") =>
			joinSharedDatabase(
				{ agentDir, cwd: project, pinLocalSessions: true, url: databaseUrl, ...options },
				source,
			).then(
				() => assert.fail("joined"),
				(error: Error) => error,
			);
		const conflictSdk = await reject({ token: "a", tokenFile: "b" }, "sdk");
		assert.ok(isTeamProfileConfigError(conflictSdk));
		assert.deepEqual([conflictSdk.code, conflictSdk.field], ["conflicting-token", "token, tokenFile"]);
		const conflictCli = (await reject({ token: "a", tokenFile: "b" }, "cli")) as TeamProfileConfigError;
		assert.deepEqual([conflictCli.code, conflictCli.field], ["conflicting-token", "--token-file"]);
		const empty = (await reject({ token: "  " }, "sdk")) as TeamProfileConfigError;
		assert.deepEqual([empty.code, empty.field], ["empty-token", "token"]);
		const missing = (await reject({ url: "libsql://db.example" }, "sdk")) as TeamProfileConfigError;
		assert.deepEqual([missing.code, missing.field], ["missing-token", "token"]);
		const prefix = (await reject({ prefix: "sqlite_x" }, "sdk")) as TeamProfileConfigError;
		assert.deepEqual(
			[prefix.code, prefix.hint],
			["invalid-prefix", "Choose a prefix that does not start with sqlite_."],
		);
		const relative = (await reject({ tokenFile: "relative-token" }, "sdk")) as TeamProfileConfigError;
		assert.equal(relative.path, join(project, "relative-token"));
		const settings = await reject({}, "sdk");
		assert.ok(isTeamProfileError(settings));
		assert.equal(settings.code, "settings-unreadable");
	});

	test(
		"a failed settings write keeps a reused token file and removes a new one, recording a cleanup failure (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			const joined = await joinSharedDatabase(
				{ url: databaseUrl, token: "kept", agentDir, cwd: project, pinLocalSessions: true },
				"sdk",
			);
			vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock").mockImplementation(() => {
				throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
			});
			const reused = await joinSharedDatabase(
				{ url: databaseUrl, token: "kept", agentDir, cwd: project, pinLocalSessions: true },
				"sdk",
			).then(
				() => assert.fail("joined"),
				(error: Error) => error,
			);
			assert.ok(isTeamProfileError(reused));
			assert.equal(reused.code, "settings-write-failed");
			assert.equal(readFileSync(joined.tokenPath!, "utf8"), "kept");
			assert.equal(tokenFiles().length, 1);
			assert.equal((reused as { cleanupCause?: Error }).cleanupCause, undefined);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test("leave removes each key only in the exact form join writes (#4320)", async () => {
		const tokenPath = join(agentDir, "storage-token.one");
		const joined = {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: "libsql://team.example" },
			secrets: { authToken: { file: "agent/storage-token.one" } },
		};
		const cases: [object | undefined, string[], string[]][] = [
			[joined, ["storage"], []],
			[{ ...joined, prefix: "t_" }, ["storage"], []],
			[{ ...joined, adapter: "@other/adapter" }, [], ["storage"]],
			[{ ...joined, extra: true }, [], ["storage"]],
			[{ adapter: LIBSQL_ADAPTER_PACKAGE, secrets: joined.secrets }, [], ["storage"]],
			[{ ...joined, options: { url: 7 } }, [], ["storage"]],
			[{ ...joined, options: { url: "libsql://x", tls: false } }, [], ["storage"]],
			[{ adapter: LIBSQL_ADAPTER_PACKAGE, options: { url: "libsql://x" } }, [], ["storage"]],
			[{ adapter: LIBSQL_ADAPTER_PACKAGE, options: { url: "file:///x.sqlite" } }, ["storage"], []],
			[{ ...joined, secrets: { authToken: { file: "agent/other-token" } } }, [], ["storage"]],
			[{ ...joined, secrets: { authToken: { file: "elsewhere/storage-token.one" } } }, [], ["storage"]],
			[{ ...joined, secrets: { authToken: { env: "TOKEN" } } }, [], ["storage"]],
			[{ ...joined, secrets: { authToken: joined.secrets.authToken, more: { env: "X" } } }, [], ["storage"]],
			[{ path: "shared.sqlite" }, [], ["storage"]],
		];
		for (const [storage, removed, kept] of cases) {
			writeFileSync(tokenPath, "t");
			writeSettings({ theme: "dark", ...(storage === undefined ? {} : { storage }) });
			const left = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
			assert.deepEqual([left.removed, left.kept], [removed, kept], JSON.stringify(storage));
			assert.equal(left.broker === undefined, removed.length === 0, JSON.stringify(storage));
			assert.deepEqual(Object.keys(saved()), removed.length === 0 ? ["theme", "storage"] : ["theme"]);
		}
		writeFileSync(tokenPath, "t");
		writeSettings({ storage: joined, sessions: { storage: { path: "mine.sqlite" } } });
		const pinKept = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
		assert.deepEqual([pinKept.removed, pinKept.kept], [["storage"], ["sessions.storage"]]);
		assert.deepEqual(saved(), { sessions: { storage: { path: "mine.sqlite" } } });
		writeSettings({ storage: { path: "theirs.sqlite" }, sessions: { storage: LOCAL_SESSIONS_STORAGE } });
		const storageKept = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
		assert.deepEqual([storageKept.removed, storageKept.kept], [["sessions.storage"], ["storage"]]);
		assert.deepEqual(saved(), { storage: { path: "theirs.sqlite" } });
		const pins: [object, boolean][] = [
			[LOCAL_SESSIONS_STORAGE, true],
			[{ path: "workflows/journal.sqlite", prefix: "x" }, false],
			[{ path: "other.sqlite" }, false],
			[{}, false],
			[{ dir: "sessions" }, false],
		];
		for (const [pin, removes] of pins) {
			writeSettings({ sessions: { storage: pin } });
			const left = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
			assert.deepEqual([left.removed, left.kept], removes ? [["sessions.storage"], []] : [[], ["sessions.storage"]]);
			assert.equal(left.broker, undefined);
			assert.deepEqual(saved(), removes ? {} : { sessions: { storage: pin } });
		}
	});

	test("leave keeps a token file any remaining global or project setting references (#4320)", async () => {
		const join_ = {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: "libsql://team.example" },
			secrets: { authToken: { file: "agent/storage-token.shared" } },
		};
		const tokenPath = join(agentDir, "storage-token.shared");
		const references: object[] = [
			{ workflows: { journal: join_ } },
			{ sessions: { storage: { ...join_ } } },
			{ workflows: { journal: { ...join_, secrets: { authToken: { file: tokenPath } } } } },
		];
		for (const reference of references) {
			writeFileSync(tokenPath, "t");
			writeSettings({ storage: join_, ...reference });
			const left = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
			assert.deepEqual([left.deletedTokenFiles, left.keptTokenFiles], [[], [tokenPath]], JSON.stringify(reference));
		}
		writeFileSync(tokenPath, "t");
		writeSettings({ storage: join_, sessions: { storage: { dir: "sessions" } }, workflows: ["./flows"] });
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), JSON.stringify({ workflows: { journal: join_ } }));
		new ProjectTrustStore(agentDir).set(project, true);
		const projectReference = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
		assert.deepEqual(projectReference.keptTokenFiles, [tokenPath]);
		writeFileSync(join(project, ".atomic", "settings.json"), "{}");
		writeSettings({ storage: join_ });
		const deleted = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
		assert.deepEqual([deleted.deletedTokenFiles, deleted.keptTokenFiles], [[tokenPath], []]);
		assert.deepEqual(tokenFiles(), []);
		assert.deepEqual(deleted.broker, { status: "not-running" });
	});

	test("a settings write failure or lock during leave is typed and keeps the settings (#4320)", async () => {
		writeSettings({ sessions: { storage: LOCAL_SESSIONS_STORAGE } });
		const spy = vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock");
		spy.mockImplementation(() => {
			throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
		});
		const locked = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never).then(
			() => assert.fail("left"),
			(error: Error) => error,
		);
		assert.ok(isTeamProfileError(locked));
		assert.deepEqual([locked.code, locked.retryable], ["settings-locked", true]);
		assert.equal(
			locked.hint,
			"Nothing was changed. Run the command again in a few seconds; a lock left by a killed process expires after 10 seconds.",
		);
		spy.mockImplementation(() => {
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		});
		const full = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never).then(
			() => assert.fail("left"),
			(error: Error) => error,
		);
		assert.ok(full instanceof TeamProfileError);
		assert.deepEqual(
			[full.code, full.retryable, full.detail],
			["settings-write-failed", false, "ENOSPC: no space left on device"],
		);
		assert.equal(
			full.hint,
			"Nothing was changed. Check that the file and its directory are writable and the disk has space, then run the command again.",
		);
		spy.mockRestore();
		assert.deepEqual(saved(), { sessions: { storage: LOCAL_SESSIONS_STORAGE } });
	});
});

describe("the profile in effect (#4320)", () => {
	const team = {
		adapter: LIBSQL_ADAPTER_PACKAGE,
		options: { url: "libsql://team.example" },
		secrets: { authToken: { env: "TEAM_DB_TOKEN" } },
	};
	test("compares the effective selections of the three domains (#4320)", () => {
		const cases: [object, string][] = [
			[{}, "individual"],
			[{ sessions: { storage: LOCAL_SESSIONS_STORAGE } }, "individual"],
			[{ storage: team, sessions: { storage: LOCAL_SESSIONS_STORAGE } }, "team"],
			[{ storage: team, sessions: { storage: {} } }, "team"],
			[{ storage: team }, "ci"],
			[{ storage: team, sessions: { storage: { path: "workflows/journal.sqlite", prefix: "s_" } } }, "custom"],
			[{ storage: team, workflows: { journal: { path: "workflows/journal.sqlite" } } }, "custom"],
			[{ storage: team, sessions: { storage: LOCAL_SESSIONS_STORAGE }, workflows: { journal: {} } }, "custom"],
			[{ storage: { path: "shared.sqlite" }, sessions: { storage: LOCAL_SESSIONS_STORAGE } }, "custom"],
			[{ storage: { path: "shared.sqlite" } }, "custom"],
			[
				{ storage: { memory: true }, sessions: { storage: LOCAL_SESSIONS_STORAGE }, workflows: { journal: {} } },
				"individual",
			],
			[{ sessions: { storage: { dir: "sessions" } } }, "custom"],
			[{ workflows: { journal: { path: "other.sqlite" } } }, "custom"],
		];
		for (const [settings, profile] of cases) {
			writeSettings(settings);
			assert.equal(selectTeamProfile({ agentDir, cwd: project }).profile, profile, JSON.stringify(settings));
		}
		writeSettings({ storage: team });
		assert.deepEqual(selectTeamProfile({ agentDir, cwd: project }), {
			profile: "ci",
			sessions: `adapter ${LIBSQL_ADAPTER_PACKAGE}`,
			journal: `adapter ${LIBSQL_ADAPTER_PACKAGE}`,
			intercom: `adapter ${LIBSQL_ADAPTER_PACKAGE}`,
		});
		vi.spyOn(process, "cwd").mockReturnValue(project);
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		assert.equal(selectTeamProfile().profile, "ci");
	});

	test("unreadable or locked settings are typed errors (#4320)", () => {
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), "{ broken");
		new ProjectTrustStore(agentDir).set(project, true);
		const unreadable = failure(() => selectTeamProfile({ agentDir, cwd: project })) as TeamProfileError;
		assert.deepEqual(
			[unreadable.code, unreadable.subject, unreadable.hint],
			["settings-unreadable", "project settings", "Fix the settings file, then run the command again."],
		);
		assert.ok(unreadable.cause instanceof Error);
	});
});

describe("the team adapter check at startup (#4320)", () => {
	test(
		"checks only when the team database is selected, once per agent directory, and retries after a failure (#4320)",
		async () => {
			await assertTeamAdapterInstalled(agentDir);
			await assertTeamAdapterInstalled(agentDir, { adapter: "@other/adapter" });
			await assertTeamAdapterInstalled(agentDir, { path: "x.sqlite" });
			const missing = await assertTeamAdapterInstalled(agentDir, { adapter: LIBSQL_ADAPTER_PACKAGE }).then(
				() => assert.fail("passed without the adapter"),
				(error: Error) => error,
			);
			assert.ok(isTeamProfileError(missing));
			assert.deepEqual(
				[missing.code, missing.subject],
				["adapter-not-installed", `${LIBSQL_ADAPTER_PACKAGE} for ${agentDir}`],
			);
			assert.match(missing.detail ?? "", /\S/);
			assert.equal(
				missing.hint,
				`The storage selection opens the team database through it. Install it, then run again: atomic install npm:${LIBSQL_ADAPTER_PACKAGE}`,
			);
			writeSettings({ packages: [packageRoot] });
			const installed = assertTeamAdapterInstalled(agentDir, { adapter: LIBSQL_ADAPTER_PACKAGE });
			assert.equal(assertTeamAdapterInstalled(join(agentDir, "."), { adapter: LIBSQL_ADAPTER_PACKAGE }), installed);
			await installed;
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});

test("TeamProfileConfigError keeps cause, path and missing only when given (#4320)", () => {
	const bare = new TeamProfileConfigError("missing-url", { source: "sdk", field: "url", hint: "h" });
	assert.equal(Object.hasOwn(bare, "cause"), false);
	assert.equal(Object.hasOwn(bare, "path"), false);
	assert.equal(Object.hasOwn(bare, "missing"), false);
	const cause = new Error("c");
	const full = new TeamProfileConfigError("incomplete-profile", {
		source: "env",
		field: "f",
		hint: "h",
		cause,
		path: "/p",
		missing: ["A"],
	});
	assert.deepEqual(Object.getOwnPropertyDescriptor(full, "cause"), {
		value: cause,
		writable: true,
		enumerable: false,
		configurable: true,
	});
	assert.deepEqual([full.path, full.missing], ["/p", ["A"]]);
	const operation = new TeamProfileError("adapter-not-installed", { subject: "s", hint: "h" });
	assert.equal(Object.hasOwn(operation, "cause"), false);
	assert.equal(Object.hasOwn(operation, "detail"), false);
	assert.equal(
		isTeamProfileError(Object.assign(new Error("x"), { name: "TeamProfileError", code: "connection-failed" })),
		true,
	);
	assert.equal(isTeamProfileConfigError({ name: "TeamProfileConfigError", code: 3 }), false);
	assert.equal(isTeamProfileError(new StorageConfigError("sdk", "f", "r")), false);
});

describe("result shapes and edge paths (#4320)", () => {
	test(
		"a token-less file join reports only what it did, and a fresh join replaces nothing (#4320)",
		async () => {
			writeSettings({ packages: [packageRoot] });
			const joined = await joinSharedDatabase(
				{ url: databaseUrl, agentDir, cwd: project, pinLocalSessions: true },
				"sdk",
			);
			assert.deepStrictEqual(joined, {
				settingsPath: join(agentDir, "settings.json"),
				storage: { adapter: LIBSQL_ADAPTER_PACKAGE, options: { url: databaseUrl } },
				sessionsStorage: LOCAL_SESSIONS_STORAGE,
				token: "none",
			});
			writeSettings({ packages: [packageRoot], storage: { path: "" } });
			assert.equal(
				(await joinSharedDatabase({ url: databaseUrl, agentDir, cwd: project, pinLocalSessions: false }, "sdk"))
					.replaced,
				"SQLite ",
			);
			writeSettings({ packages: [packageRoot] });
			vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock").mockImplementation(() => {
				throw Object.assign(new Error("EIO"), { code: "EIO" });
			});
			const failed = await joinSharedDatabase(
				{ url: databaseUrl, agentDir, cwd: project, pinLocalSessions: true },
				"sdk",
			).then(
				() => assert.fail("joined"),
				(error: Error) => error,
			);
			assert.ok(isTeamProfileError(failed));
			assert.equal(
				failed.hint,
				"Nothing was changed: the previous selection and its token are kept. Check that the file and its directory are writable and the disk has space, then run the command again.",
			);
			assert.equal((failed as { cleanupCause?: Error }).cleanupCause, undefined);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test("a database that refuses the token fails the join before anything is written (#4320)", async () => {
		writeSettings({ packages: [packageRoot] });
		const before = readFileSync(join(agentDir, "settings.json"), "utf8");
		const refusing = createServer((_request, response) => {
			response.writeHead(401, { "content-type": "text/plain" });
			response.end("Unauthorized");
		});
		await new Promise<void>((listening) => refusing.listen(0, "127.0.0.1", listening));
		const { port } = refusing.address() as AddressInfo;
		try {
			const error = await joinSharedDatabase(
				{ url: `http://127.0.0.1:${port}`, token: "wrong-token", agentDir, cwd: project, pinLocalSessions: true },
				"sdk",
			).then(
				() => assert.fail("joined a database that refused the token"),
				(caught: Error) => caught,
			);
			assert.ok(isTeamProfileError(error));
			assert.deepEqual([error.code, error.retryable], ["connection-failed", true]);
			assert.equal(
				error.hint,
				"Nothing was changed. Check the URL, the token and the network, then run the command again.",
			);
			assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /wrong-token/);
		} finally {
			refusing.close();
		}
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
		assert.deepEqual(tokenFiles(), []);
	});

	test("leave keeps an untouched settings file byte for byte and tolerates an already deleted token file (#4320)", async () => {
		writeFileSync(join(agentDir, "settings.json"), '{"theme":"dark"}');
		const nothing = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
		assert.deepStrictEqual(nothing, {
			settingsPath: join(agentDir, "settings.json"),
			removed: [],
			kept: [],
			deletedTokenFiles: [],
			keptTokenFiles: [],
		});
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), '{"theme":"dark"}');
		const storage = {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: "libsql://team.example" },
			secrets: { authToken: { file: "agent/storage-token.gone" } },
		};
		writeSettings({ storage });
		const gone = await leaveTeamWith({ agentDir, cwd: project }, noBroker as never);
		assert.deepEqual(gone.deletedTokenFiles, [join(agentDir, "storage-token.gone")]);
		writeSettings({ sessions: { storage: LOCAL_SESSIONS_STORAGE } });
		assert.deepStrictEqual(await leaveTeamWith({ agentDir, cwd: project }, noBroker as never), {
			settingsPath: join(agentDir, "settings.json"),
			removed: ["sessions.storage"],
			kept: [],
			deletedTokenFiles: [],
			keptTokenFiles: [],
		});
	});

	test("the profile ignores untrusted project settings and reports a held lock as retryable (#4320)", () => {
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), JSON.stringify({ sessions: { storage: { dir: "s" } } }));
		new ProjectTrustStore(agentDir).set(project, false);
		assert.equal(selectTeamProfile({ agentDir, cwd: project }).profile, "individual");
		new ProjectTrustStore(agentDir).set(project, true);
		assert.equal(selectTeamProfile({ agentDir, cwd: project }).profile, "custom");
		writeSettings({ theme: "dark" });
		const release = lockfile.lockSync(join(agentDir, "settings.json"), { realpath: false });
		try {
			const locked = failure(() => selectTeamProfile({ agentDir, cwd: project })) as TeamProfileError;
			assert.deepEqual(
				[locked.code, locked.subject, locked.retryable],
				["settings-locked", "global settings", true],
			);
			assert.equal(
				locked.hint,
				"Nothing was read. Run the command again in a few seconds; a lock left by a killed process expires after 10 seconds.",
			);
		} finally {
			release();
		}
	});
});
