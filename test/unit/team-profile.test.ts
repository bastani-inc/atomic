import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk-types.js";
import { resolveSessionStore, selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import {
	isTeamProfileConfigError,
	isTeamProfileError,
	StorageConfigError,
	type TeamProfileConfigError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	hasProcessStorageSelection,
	processSharedStorageSelection,
	processStorageEnvironment,
	selectProcessStorage,
	setCliStorageSelection,
	validateProcessStorage,
} from "../../packages/coding-agent/src/core/storage/process-selection.js";
import {
	resolveAdapterOptions,
	StorageProvider,
	storageSelectionKey,
} from "../../packages/coding-agent/src/core/storage/provider.js";
import {
	environmentTeamProfile,
	getTeamProfile,
	inMemorySecret,
	LIBSQL_ADAPTER_PACKAGE,
	REDACTED_SECRET,
	selectStorage,
	teamProfileSelection,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import {
	collectStorageStatus,
	type StorageStatus,
} from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { readSharedStorageSetting } from "../../packages/intercom/broker/shared-storage-setting.js";
import { getBrokerSpawnOptions } from "../../packages/intercom/broker/spawn.js";
import type { RunOpts } from "../../packages/workflows/src/authoring.js";
import { resolveRunJournal, selectRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
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
const TEAM_URL = "libsql://team.example.turso.io";

let root: string;
let agentDir: string;
let project: string;

beforeEach(() => {
	for (const name of VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("team-profile-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function ciProfile(variables: Record<string, string>): void {
	vi.stubEnv("ATOMIC_PROFILE", "ci");
	for (const [name, value] of Object.entries(variables)) vi.stubEnv(name, value);
}

function rejects(
	action: () => object | undefined,
	source: string,
	field: string,
	code: string,
): TeamProfileConfigError {
	let caught: TeamProfileConfigError | undefined;
	assert.throws(action, (error: Error) => {
		assert.ok(error instanceof StorageConfigError, "a StorageConfigError");
		assert.ok(isTeamProfileConfigError(error));
		assert.deepEqual([error.source, error.field, error.reason, error.code], [source, field, code, code]);
		caught = error;
		return true;
	});
	assert.ok(caught);
	return caught;
}

describe("ATOMIC_PROFILE=ci (#4320)", () => {
	test("selects the team database for sessions, workflow runs and Intercom without writing settings (#4320)", async () => {
		ciProfile({ ATOMIC_TEAM_URL: TEAM_URL, ATOMIC_TEAM_TOKEN: "ci-secret-token", ATOMIC_TEAM_PREFIX: "team_" });
		const expected = {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: TEAM_URL },
			secrets: { authToken: { env: "ATOMIC_TEAM_TOKEN" } },
			prefix: "team_",
		};
		const selection = {
			kind: "adapter",
			module: LIBSQL_ADAPTER_PACKAGE,
			options: { url: TEAM_URL },
			secrets: { authToken: { env: "ATOMIC_TEAM_TOKEN" } },
			prefix: "team_",
		};
		validateProcessStorage(agentDir);
		for (const domain of ["sessions", "journal"] as const) {
			assert.deepEqual(selectProcessStorage(domain, agentDir, project), {
				selection,
				source: "env",
				field: "ATOMIC_PROFILE",
			});
			assert.equal(hasProcessStorageSelection(domain), true);
		}
		assert.deepEqual(selectSessionStorage(project, { agentDir }), selection);
		assert.deepEqual(selectRunJournal({ agentDir }), selection);
		assert.deepEqual(JSON.parse(processSharedStorageSelection() ?? "null"), expected);
		assert.deepEqual(JSON.parse(getBrokerSpawnOptions().env.ATOMIC_STORAGE ?? "null"), expected);
		assert.deepEqual(readSharedStorageSetting(agentDir, processStorageEnvironment()), expected);
		assert.doesNotMatch(processSharedStorageSelection() ?? "", /ci-secret-token/);

		const status = await collectStorageStatus({ cwd: project, agentDir, probe: false });
		assert.deepEqual(
			status.domains.map((domain) => [domain.domain, domain.source, domain.selection]),
			[
				["sessions", "ATOMIC_PROFILE=ci", `adapter ${LIBSQL_ADAPTER_PACKAGE} (prefix team_)`],
				["journal", "ATOMIC_PROFILE=ci", `adapter ${LIBSQL_ADAPTER_PACKAGE} (prefix team_)`],
				["intercom", "ATOMIC_PROFILE=ci", `adapter ${LIBSQL_ADAPTER_PACKAGE} (prefix team_)`],
			],
		);
		assert.deepEqual(await getTeamProfile({ agentDir, cwd: project }), {
			profile: "ci",
			sessions: `adapter ${LIBSQL_ADAPTER_PACKAGE} (prefix team_)`,
			journal: `adapter ${LIBSQL_ADAPTER_PACKAGE} (prefix team_)`,
			intercom: `adapter ${LIBSQL_ADAPTER_PACKAGE} (prefix team_)`,
		});
		assert.deepEqual(readdirSync(agentDir), []);
		assert.equal(existsSync(join(agentDir, "settings.json")), false);
	});

	test("a token file is referenced by absolute path, and a file: URL needs no token (#4320)", () => {
		writeFileSync(join(project, "token"), "file-token\n");
		vi.stubEnv("ATOMIC_TEAM_TOKEN_FILE", "token");
		ciProfile({ ATOMIC_TEAM_URL: TEAM_URL });
		assert.deepEqual(environmentTeamProfile(process.env, project), {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: TEAM_URL },
			secrets: { authToken: { file: join(project, "token") } },
		});
		vi.stubEnv("ATOMIC_TEAM_TOKEN_FILE", "");
		vi.stubEnv("ATOMIC_TEAM_URL", "file:///srv/team.sqlite");
		assert.deepEqual(environmentTeamProfile(), {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: "file:///srv/team.sqlite" },
		});
	});

	test("more specific process selections outrank the profile (#4320)", async () => {
		assert.equal(selectProcessStorage("sessions", agentDir, project), undefined);
		assert.equal(processSharedStorageSelection(), undefined);
		assert.equal(hasProcessStorageSelection("sessions"), false);

		ciProfile({ ATOMIC_TEAM_URL: TEAM_URL, ATOMIC_TEAM_TOKEN: "t" });
		vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ path: join(root, "explicit.sqlite") }));
		assert.equal(selectProcessStorage("journal", agentDir)?.field, "ATOMIC_STORAGE");
		assert.deepEqual(JSON.parse(processSharedStorageSelection() ?? "null"), { path: join(root, "explicit.sqlite") });
		vi.stubEnv("ATOMIC_STORAGE", "");
		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify({ dir: join(root, "sessions") }));
		assert.equal(selectProcessStorage("sessions", agentDir)?.field, "ATOMIC_SESSIONS_STORAGE");
		assert.equal(selectProcessStorage("journal", agentDir)?.field, "ATOMIC_PROFILE");
		assert.equal((await getTeamProfile({ agentDir, cwd: project })).profile, "custom");
	});

	test("bad profile input is a typed StorageConfigError at startup, naming the variable (#4320)", () => {
		const validate = () => {
			validateProcessStorage(agentDir);
			return {};
		};
		vi.stubEnv("ATOMIC_TEAM_URL", "libsql://partial.example.turso.io");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "partial-secret");
		const partial = rejects(validate, "env", "ATOMIC_PROFILE", "incomplete-profile");
		assert.deepEqual(partial.missing, ["ATOMIC_PROFILE"]);
		assert.equal(
			partial.message,
			"Invalid storage configuration: ATOMIC_PROFILE (incomplete-profile). ATOMIC_TEAM_URL, ATOMIC_TEAM_TOKEN are set but ATOMIC_PROFILE is not: set ATOMIC_PROFILE=ci to use the team database in this process, or unset them (to join this machine to the team database instead, run atomic team join <url> --token-file <path>).",
		);
		vi.stubEnv("ATOMIC_TEAM_URL", "");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "");
		vi.stubEnv("ATOMIC_TEAM_PREFIX", "team_");
		assert.match(
			rejects(validate, "env", "ATOMIC_PROFILE", "incomplete-profile").hint,
			/^ATOMIC_TEAM_PREFIX is set .* unset it /,
		);
		vi.stubEnv("ATOMIC_TEAM_PREFIX", "");
		vi.stubEnv("ATOMIC_PROFILE", "team");
		rejects(validate, "env", "ATOMIC_PROFILE", "unknown-profile");
		vi.stubEnv("ATOMIC_PROFILE", "ci");
		const nothing = rejects(
			validate,
			"env",
			"ATOMIC_TEAM_URL, ATOMIC_TEAM_TOKEN or ATOMIC_TEAM_TOKEN_FILE",
			"incomplete-profile",
		);
		assert.deepEqual(nothing.missing, ["ATOMIC_TEAM_URL", "ATOMIC_TEAM_TOKEN or ATOMIC_TEAM_TOKEN_FILE"]);
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "t");
		assert.deepEqual(rejects(validate, "env", "ATOMIC_TEAM_URL", "incomplete-profile").missing, ["ATOMIC_TEAM_URL"]);
		vi.stubEnv("ATOMIC_TEAM_URL", "postgres://db");
		rejects(validate, "env", "ATOMIC_TEAM_URL", "unsupported-url");
		vi.stubEnv("ATOMIC_TEAM_URL", "file:team.sqlite");
		rejects(validate, "env", "ATOMIC_TEAM_URL", "relative-file-url");
		vi.stubEnv("ATOMIC_TEAM_URL", "libsql://db.example.turso.io?authToken=url-secret");
		const credential = rejects(validate, "env", "ATOMIC_TEAM_URL", "credential-in-url");
		assert.doesNotMatch(credential.message, /url-secret/);
		vi.stubEnv("ATOMIC_TEAM_URL", TEAM_URL);
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "");
		assert.deepEqual(
			rejects(validate, "env", "ATOMIC_TEAM_TOKEN or ATOMIC_TEAM_TOKEN_FILE", "incomplete-profile").missing,
			["ATOMIC_TEAM_TOKEN or ATOMIC_TEAM_TOKEN_FILE"],
		);
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "t");
		vi.stubEnv("ATOMIC_TEAM_TOKEN_FILE", join(root, "missing-token"));
		rejects(validate, "env", "ATOMIC_TEAM_TOKEN, ATOMIC_TEAM_TOKEN_FILE", "conflicting-token");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "");
		const unreadable = rejects(validate, "env", "ATOMIC_TEAM_TOKEN_FILE", "unreadable-token-file");
		assert.equal(unreadable.path, join(root, "missing-token"));
		assert.ok(unreadable.cause instanceof Error);
		writeFileSync(join(root, "empty-token"), " \n");
		vi.stubEnv("ATOMIC_TEAM_TOKEN_FILE", join(root, "empty-token"));
		rejects(validate, "env", "ATOMIC_TEAM_TOKEN_FILE", "empty-token");
		vi.stubEnv("ATOMIC_TEAM_TOKEN_FILE", "");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "  ");
		rejects(validate, "env", "ATOMIC_TEAM_TOKEN", "empty-token");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "t");
		vi.stubEnv("ATOMIC_TEAM_PREFIX", "9team");
		const prefix = rejects(validate, "env", "ATOMIC_TEAM_PREFIX", "invalid-prefix");
		assert.equal(prefix.retryable, false);
		vi.stubEnv("ATOMIC_TEAM_PREFIX", "sqlite_team");
		const reserved = rejects(validate, "env", "ATOMIC_TEAM_PREFIX", "invalid-prefix");
		assert.equal(
			reserved.message,
			"Invalid storage configuration: ATOMIC_TEAM_PREFIX (invalid-prefix). Choose a prefix that does not start with sqlite_.",
		);
		assert.equal(reserved.hint, "Choose a prefix that does not start with sqlite_.");
	});
});

describe("teamProfileSelection (#4320)", () => {
	test("a literal token is an in-memory secret that never serializes (#4320)", () => {
		const selection = teamProfileSelection({
			profile: "ci",
			url: TEAM_URL,
			token: "memory-secret-token",
			prefix: "t_",
		});
		const secret = selection.secrets?.authToken;
		assert.ok(secret !== undefined && "value" in secret);
		assert.equal(secret.value, "memory-secret-token");
		assert.deepEqual(selection.options, { url: TEAM_URL });
		assert.equal(selection.prefix, "t_");
		const serialized = JSON.stringify(selection);
		assert.equal(
			serialized,
			JSON.stringify({
				adapter: LIBSQL_ADAPTER_PACKAGE,
				options: { url: TEAM_URL },
				secrets: { authToken: { value: REDACTED_SECRET } },
				prefix: "t_",
			}),
		);
		assert.doesNotMatch(inspect(selection, { depth: 5 }), /memory-secret-token/);
		assert.doesNotMatch(inspect(selection, { depth: 5, showHidden: false }), /memory-secret-token/);
		assert.deepEqual({ ...secret }, {});

		const sdk: CreateAgentSessionOptions = { storage: selection };
		const run: RunOpts = { journal: selection };
		assert.equal(sdk.storage, run.journal);
	});

	test("tokenFile and tokenEnv are references, checked before they are used (#4320)", () => {
		writeFileSync(join(root, "token"), "from-file\n");
		assert.deepEqual(teamProfileSelection({ profile: "ci", url: TEAM_URL, tokenFile: join(root, "token") }), {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: TEAM_URL },
			secrets: { authToken: { file: join(root, "token") } },
		});
		rejects(
			() => teamProfileSelection({ profile: "ci", url: TEAM_URL, tokenEnv: "MY_TEAM_TOKEN" }),
			"sdk",
			"tokenEnv",
			"missing-token",
		);
		vi.stubEnv("MY_TEAM_TOKEN", "env-secret");
		assert.deepEqual(teamProfileSelection({ profile: "ci", url: TEAM_URL, tokenEnv: "MY_TEAM_TOKEN" }), {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: TEAM_URL },
			secrets: { authToken: { env: "MY_TEAM_TOKEN" } },
		});
		const select = (options: Parameters<typeof teamProfileSelection>[0]) => () => teamProfileSelection(options);
		rejects(select({ profile: "team" as "ci", url: TEAM_URL, token: "t" }), "sdk", "profile", "unknown-profile");
		rejects(select({ profile: "ci", url: "", token: "t" }), "sdk", "url", "missing-url");
		rejects(select({ profile: "ci", url: TEAM_URL }), "sdk", "token", "missing-token");
		rejects(select({ profile: "ci", url: TEAM_URL, token: " " }), "sdk", "token", "empty-token");
		rejects(select({ profile: "ci", url: TEAM_URL, tokenEnv: "" }), "sdk", "tokenEnv", "empty-token");
		rejects(
			select({ profile: "ci", url: TEAM_URL, token: "a", tokenFile: "b" }),
			"sdk",
			"token, tokenFile, tokenEnv",
			"conflicting-token",
		);
		rejects(
			select({ profile: "ci", url: TEAM_URL, tokenFile: join(root, "absent") }),
			"sdk",
			"tokenFile",
			"unreadable-token-file",
		);
		rejects(select({ profile: "ci", url: TEAM_URL, token: "t", prefix: "a-b" }), "sdk", "prefix", "invalid-prefix");
		const failure = rejects(
			select({ profile: "ci", url: "https://user:pass@team.example", token: "sdk-secret" }),
			"sdk",
			"url",
			"credential-in-url",
		);
		assert.doesNotMatch(`${failure.message}${JSON.stringify(failure)}`, /pass@|sdk-secret/);
	});

	test("an in-memory secret is refused from settings and process JSON, and never reaches status output (#4320)", async () => {
		const settingsForm = { adapter: LIBSQL_ADAPTER_PACKAGE, secrets: { authToken: { value: "settings-secret" } } };
		assert.throws(
			() => selectStorage(settingsForm, "settings", "storage", ""),
			(error: Error) =>
				error instanceof StorageConfigError &&
				error.reason === "in-memory-secret-unsupported" &&
				!error.message.includes("settings-secret"),
		);
		const fromSdk = selectStorage(settingsForm, "sdk", "storage", "");
		assert.ok(fromSdk.kind === "adapter");
		assert.doesNotMatch(JSON.stringify(fromSdk), /settings-secret/);

		const selection = teamProfileSelection({ profile: "ci", url: TEAM_URL, token: "status-secret-token" });
		vi.stubEnv("ATOMIC_STORAGE", JSON.stringify(selection));
		assert.throws(
			() => validateProcessStorage(agentDir),
			(error: Error) => error instanceof StorageConfigError && error.reason === "invalid-selection",
		);
		const out: string[] = [];
		const err: string[] = [];
		const code = await runStorageCommand(["status", "--json"], {
			cwd: project,
			agentDir,
			log: (line) => out.push(line),
			error: (line) => err.push(line),
		});
		assert.equal(code, 1);
		const status: StorageStatus = JSON.parse(out.join("\n"));
		assert.equal(status.domains[0]?.selection, "invalid");
		assert.doesNotMatch(`${out.join("\n")}${err.join("\n")}`, /status-secret-token/);
	});

	test(
		"the selection opens sessions and workflow runs as createAgentSession({ storage }) and RunOpts.journal use it (#4320)",
		async () => {
			const databaseDirectory = makeLibsqlDirectory();
			try {
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
				const path = join(databaseDirectory, "team.sqlite");
				await (await openNodeSqliteDatabase(path)).close();
				const selection = teamProfileSelection({
					profile: "ci",
					url: pathToFileURL(path).href,
					token: "open-secret-token",
				});
				const sessionStore = selectStorage(selection, "sdk", "storage", "");
				const store = await resolveSessionStore(project, { agentDir, sessionStore });
				await store.close();
				const journal = await resolveRunJournal({ agentDir, journal: selection });
				await journal.close();
				const unreachable = teamProfileSelection({
					profile: "ci",
					url: pathToFileURL(join(databaseDirectory, "absent", "dir", "db.sqlite")).href,
					token: "open-secret-token",
				});
				const failure = await new StorageProvider()
					.openSessionStore(selectStorage(unreachable, "sdk", "storage", ""), { agentDir, domain: "sessions" })
					.then(
						() => assert.fail("opened an unreachable database"),
						(error: Error) => error,
					);
				assert.doesNotMatch(`${failure.message}${inspect(failure, { depth: 6 })}`, /open-secret-token/);
			} finally {
				await removeLibsqlDirectory(databaseDirectory);
			}
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test("in-memory secrets key open connections by identity, not by value (#4320)", () => {
		const first = inMemorySecret("identity-secret");
		const second = inMemorySecret("identity-secret");
		const key = (secret: ReturnType<typeof inMemorySecret>) =>
			storageSelectionKey({ kind: "adapter", module: "x", secrets: { authToken: secret } }, agentDir);
		assert.equal(key(first), key(first));
		assert.notEqual(key(first), key(second));
		assert.doesNotMatch(key(first), /identity-secret/);
	});

	test("a missing adapter fails createAgentSession before any store opens (#4320)", async () => {
		const opens = vi.spyOn(StorageProvider.prototype, "openSessionStore");
		const loads = vi.spyOn(StorageProvider.prototype, "openRunJournal");
		const attempt = (options: CreateAgentSessionOptions) =>
			createAgentSession({ cwd: project, agentDir, ...options }).then(
				() => assert.fail("created a session without the adapter"),
				(error: Error) => error,
			);
		ciProfile({ ATOMIC_TEAM_URL: TEAM_URL, ATOMIC_TEAM_TOKEN: "t" });
		const fromProfile = await attempt({});
		assert.ok(isTeamProfileError(fromProfile));
		assert.equal(fromProfile.code, "adapter-not-installed");
		assert.match(
			fromProfile.hint,
			/^ATOMIC_PROFILE=ci opens the team database through it\. .*atomic install npm:@bastani\/atomic-storage-libsql$/,
		);
		vi.stubEnv("ATOMIC_PROFILE", "");
		vi.stubEnv("ATOMIC_TEAM_URL", "");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "");
		const fromStorage = await attempt({
			storage: teamProfileSelection({ profile: "ci", url: TEAM_URL, token: "t" }),
		});
		assert.ok(isTeamProfileError(fromStorage));
		assert.match(fromStorage.hint, /^The storage selection opens the team database through it\./);
		assert.equal(opens.mock.calls.length + loads.mock.calls.length, 0);
		assert.deepEqual(readdirSync(agentDir), []);
	});

	test("an in-memory secret reaches the adapter's options, and secret order never changes the connection key (#4320)", async () => {
		const options = await resolveAdapterOptions(
			{
				kind: "adapter",
				module: "x",
				options: { url: "libsql://db" },
				secrets: { authToken: inMemorySecret("resolved") },
			},
			{ agentDir, domain: "sessions" },
		);
		assert.deepEqual({ ...options }, { url: "libsql://db", authToken: "resolved" });
		const ordered = storageSelectionKey(
			{ kind: "adapter", module: "x", secrets: { a: { env: "A" }, b: { env: "B" } } },
			agentDir,
		);
		const reversed = storageSelectionKey(
			{ kind: "adapter", module: "x", secrets: { b: { env: "B" }, a: { env: "A" } } },
			agentDir,
		);
		assert.equal(ordered, reversed);
		assert.notEqual(
			ordered,
			storageSelectionKey({ kind: "adapter", module: "x", secrets: { a: { env: "B" }, b: { env: "A" } } }, agentDir),
		);
	});

	test("a --storage flag outranks the CI profile for the broker too (#4320)", () => {
		ciProfile({ ATOMIC_TEAM_URL: TEAM_URL, ATOMIC_TEAM_TOKEN: "t" });
		setCliStorageSelection(
			{ flag: "--storage", value: JSON.stringify({ path: join(root, "flag.sqlite") }) },
			project,
		);
		try {
			assert.deepEqual(JSON.parse(processSharedStorageSelection() ?? "null"), { path: join(root, "flag.sqlite") });
			assert.equal(processStorageEnvironment().ATOMIC_STORAGE, JSON.stringify({ path: join(root, "flag.sqlite") }));
		} finally {
			setCliStorageSelection(undefined);
		}
		vi.stubEnv("ATOMIC_PROFILE", "");
		vi.stubEnv("ATOMIC_TEAM_URL", "");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "");
		assert.equal(processStorageEnvironment().ATOMIC_STORAGE, "");
	});
});
