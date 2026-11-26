import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	isTeamProfileConfigError,
	isTeamProfileError,
	StorageConfigError,
	TeamProfileConfigError,
	TeamProfileError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	checkTeamPrefix,
	inMemorySecret,
	LOCAL_SESSIONS_STORAGE,
	POSTGRES_ADAPTER_PACKAGE,
	REDACTED_SECRET,
	readTeamTokenFile,
	selectStorage,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import { selectIntercomStorage } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { selectTeamProfile } from "../../packages/coding-agent/src/core/storage/team.js";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const VARIABLES = [
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
	for (const name of VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("team-contract-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function writeSettings(settings: object): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

function failure(action: () => unknown): Error {
	try {
		action();
	} catch (error) {
		return error as Error;
	}
	return assert.fail("did not throw");
}

describe("shared-database input checks name the field and the fix (#4320)", () => {
	test("prefixes and token files (#4320)", () => {
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
				`The token file ${path} is empty: write the database password or token into it.`,
			],
		);
		writeFileSync(path, "  a.b.c \n");
		assert.equal(readTeamTokenFile(path, "sdk"), "a.b.c");
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
			path: join(agentDir, "shared.sqlite"),
		});
		assert.deepEqual(selectIntercomStorage(agentDir, { path: "" }), {
			kind: "sqlite",
			path: join(agentDir, "storage.sqlite"),
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

describe("the profile in effect (#4320)", () => {
	const team = {
		adapter: POSTGRES_ADAPTER_PACKAGE,
		options: { url: "postgres://atomic@team.example.com/atomic" },
		secrets: { password: { env: "TEAM_DB_PASSWORD" } },
	};
	test("compares the effective selections of sessions and Intercom (#4320)", () => {
		const cases: [object, string][] = [
			[{}, "individual"],
			[{ sessions: { storage: LOCAL_SESSIONS_STORAGE } }, "individual"],
			[{ storage: team, sessions: { storage: LOCAL_SESSIONS_STORAGE } }, "team"],
			[{ storage: team, sessions: { storage: {} } }, "team"],
			[{ storage: team }, "ci"],
			[{ storage: team, sessions: { storage: { path: "workflows/journal.sqlite", prefix: "s_" } } }, "custom"],
			// The workflow journal selection of earlier releases selects nothing.
			[{ storage: team, workflows: { journal: { path: "workflows/journal.sqlite" } } }, "ci"],
			[{ storage: team, sessions: { storage: LOCAL_SESSIONS_STORAGE }, workflows: { journal: {} } }, "team"],
			[{ storage: { path: "shared.sqlite" }, sessions: { storage: LOCAL_SESSIONS_STORAGE } }, "custom"],
			[{ storage: { path: "shared.sqlite" } }, "custom"],
			[{ storage: { memory: true }, sessions: { storage: LOCAL_SESSIONS_STORAGE } }, "custom"],
			[{ sessions: { storage: { dir: "sessions" } } }, "custom"],
			[{ workflows: { journal: { path: "other.sqlite" } } }, "individual"],
		];
		for (const [settings, profile] of cases) {
			writeSettings(settings);
			assert.equal(selectTeamProfile({ agentDir, cwd: project }).profile, profile, JSON.stringify(settings));
		}
		writeSettings({ storage: team });
		assert.deepEqual(selectTeamProfile({ agentDir, cwd: project }), {
			profile: "ci",
			sessions: `PostgreSQL postgres://team.example.com/atomic via ${POSTGRES_ADAPTER_PACKAGE}`,
			intercom: `PostgreSQL postgres://team.example.com/atomic via ${POSTGRES_ADAPTER_PACKAGE}`,
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
			[unreadable.code, unreadable.subject, unreadable.detail, unreadable.hint],
			[
				"settings-unreadable",
				"project settings",
				"not valid JSON at line 1, column 3",
				"Fix the settings file, then run the command again.",
			],
		);
		assert.ok(unreadable.cause instanceof Error);
	});
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

describe("the profile in effect, read only (#4320, #5161)", () => {
	test("the profile ignores untrusted project settings and is read while another process holds the lock (#4320, #5161)", () => {
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), JSON.stringify({ sessions: { storage: { dir: "s" } } }));
		new ProjectTrustStore(agentDir).set(project, false);
		assert.equal(selectTeamProfile({ agentDir, cwd: project }).profile, "individual");
		new ProjectTrustStore(agentDir).set(project, true);
		assert.equal(selectTeamProfile({ agentDir, cwd: project }).profile, "custom");
		writeSettings({ theme: "dark" });
		// Reading settings never takes the write lock (#5161): saves replace the file whole, so a held lock never stops it.
		const release = lockfile.lockSync(join(agentDir, "settings.json"), { realpath: false });
		try {
			assert.equal(selectTeamProfile({ agentDir, cwd: project }).profile, "custom");
		} finally {
			release();
		}
	});
});

test("setStorageLayout replaces only the keys it is given (#4320)", () => {
	const manager = SettingsManager.inMemory({
		theme: "dark",
		storage: { path: "shared.sqlite" },
		sessions: { storage: { path: "mine.sqlite" } },
	});
	manager.setStorageLayout({ sessionsStorage: undefined });
	assert.deepEqual(
		[manager.getGlobalSettings().storage, manager.getGlobalSettings().sessions],
		[{ path: "shared.sqlite" }, undefined],
	);
	manager.setStorageLayout({ sessionsStorage: LOCAL_SESSIONS_STORAGE });
	manager.setStorageLayout({ storage: undefined });
	assert.deepEqual(
		[manager.getGlobalSettings().storage, manager.getGlobalSettings().sessions],
		[undefined, { storage: LOCAL_SESSIONS_STORAGE }],
	);
	assert.equal(manager.getGlobalSettings().theme, "dark");
});
