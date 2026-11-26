import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import {
	isTeamProfileConfigError,
	StorageConfigError,
	type TeamProfileConfigError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	processSharedStorageSelection,
	processStorageEnvironment,
	selectProcessStorage,
	setCliStorageSelection,
	validateProcessStorage,
	validateProcessStorageAsync,
} from "../../packages/coding-agent/src/core/storage/process-selection.js";
import {
	resolveAdapterOptions,
	StorageProvider,
	storageSelectionKey,
} from "../../packages/coding-agent/src/core/storage/provider.js";
import {
	getTeamProfile,
	inMemorySecret,
	REDACTED_SECRET,
	selectStorage,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import type { StorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_PROFILE",
	"ATOMIC_TEAM_URL",
	"ATOMIC_TEAM_TOKEN",
	"ATOMIC_TEAM_TOKEN_FILE",
	"ATOMIC_TEAM_PREFIX",
];
const NO_BUILTINS = { subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const LIBSQL = { adapter: "@bastani/atomic-storage-libsql", options: { url: "libsql://team.example.turso.io" } };
const MOVING_OFF_LIBSQL = "https://docs.bastani.ai/storage#moving-off-libsql";

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

/** The libSQL refusal: a typed config error that says libSQL was removed and how to move sessions off it. */
function isLibsqlRemoval(source: string, field: string) {
	return (error: Error) => {
		assert.ok(error instanceof StorageConfigError, `${error}`);
		assert.deepEqual([error.source, error.field, error.reason], [source, field, "libsql-removed"]);
		assert.match(
			error.message,
			/libSQL support \(Turso, sqld and libSQL file: databases\) was removed in Atomic 0\.10\.11/,
		);
		assert.match(
			error.message,
			/export them with Atomic 0\.10\.11-alpha\.2, which reads every libSQL database \(npx -y @bastani\/atomic@0\.10\.11-alpha\.2 storage export/,
		);
		assert.match(
			error.message,
			/import them into SQLite or PostgreSQL with this release \(atomic storage import <dir>\)/,
		);
		assert.ok(error.message.includes(MOVING_OFF_LIBSQL), error.message);
		return true;
	};
}

describe("the removed ATOMIC_PROFILE=ci team profile", () => {
	test("each of its variables fails fast, naming every one that is set and the PostgreSQL replacement", async () => {
		for (const name of VARIABLES.slice(3)) {
			vi.stubEnv(name, name === "ATOMIC_PROFILE" ? "ci" : "set");
			assert.throws(() => validateProcessStorage(agentDir), isLibsqlRemoval("env", name));
			await assert.rejects(validateProcessStorageAsync(agentDir), isLibsqlRemoval("env", name));
			assert.throws(() => selectProcessStorage("sessions", agentDir, project), isLibsqlRemoval("env", name));
			vi.stubEnv(name, "");
		}
		vi.stubEnv("ATOMIC_PROFILE", "ci");
		vi.stubEnv("ATOMIC_TEAM_URL", "libsql://team.example.turso.io");
		vi.stubEnv("ATOMIC_TEAM_TOKEN", "team-secret-token");
		let failure: TeamProfileConfigError | undefined;
		assert.throws(
			() => validateProcessStorage(agentDir),
			(error: Error) => {
				assert.ok(isTeamProfileConfigError(error));
				failure = error;
				return isLibsqlRemoval("env", "ATOMIC_PROFILE, ATOMIC_TEAM_URL, ATOMIC_TEAM_TOKEN")(error);
			},
		);
		assert.equal(failure?.code, "libsql-removed");
		assert.match(
			failure?.hint ?? "",
			/select a PostgreSQL database instead: run atomic storage join postgres:\/\/… or set ATOMIC_STORAGE/,
		);
		assert.doesNotMatch(`${failure?.message}${JSON.stringify(failure)}`, /team-secret-token/);
		// The selection a broker or Intercom session receives refuses them too, instead of starting without a database.
		const removal = isLibsqlRemoval("env", "ATOMIC_PROFILE, ATOMIC_TEAM_URL, ATOMIC_TEAM_TOKEN");
		assert.throws(() => processSharedStorageSelection(), removal);
		assert.throws(() => processStorageEnvironment(), removal);
	});

	test("createAgentSession refuses them before any store opens", async () => {
		const opens = vi.spyOn(StorageProvider.prototype, "openSessionStore");
		vi.stubEnv("ATOMIC_PROFILE", "ci");
		await assert.rejects(
			createAgentSession({ cwd: project, agentDir, builtins: NO_BUILTINS }),
			isLibsqlRemoval("env", "ATOMIC_PROFILE"),
		);
		assert.equal(opens.mock.calls.length, 0);
		assert.deepEqual(readdirSync(agentDir), []);
	});
});

describe("a libSQL storage selection", () => {
	test("fails fast from settings, the environment, --storage and the SDK, whatever URL it names", () => {
		for (const url of ["libsql://team.example.turso.io", "http://127.0.0.1:8080", "file:/tmp/team.sqlite"]) {
			const selection = { ...LIBSQL, options: { url } };
			for (const source of ["settings", "env", "cli", "sdk"] as const)
				assert.throws(() => selectStorage(selection, source, "storage", ""), isLibsqlRemoval(source, "storage"));
		}
		vi.stubEnv("ATOMIC_STORAGE", JSON.stringify(LIBSQL));
		assert.throws(() => validateProcessStorage(agentDir), isLibsqlRemoval("env", "ATOMIC_STORAGE"));
		vi.stubEnv("ATOMIC_STORAGE", "");
		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify(LIBSQL));
		assert.throws(
			() => selectProcessStorage("sessions", agentDir, project),
			isLibsqlRemoval("env", "ATOMIC_SESSIONS_STORAGE"),
		);
		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", "");
		setCliStorageSelection({ flag: "--storage", value: JSON.stringify(LIBSQL) }, project);
		try {
			assert.throws(() => selectProcessStorage("shared", agentDir, project), isLibsqlRemoval("cli", "--storage"));
		} finally {
			setCliStorageSelection(undefined);
		}
	});

	test("in settings fails the session store, storage status and the team layout, never falling back to another store", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessions: { storage: LIBSQL } }));
		await assert.rejects(resolveSessionStore(project, { agentDir }), isLibsqlRemoval("settings", "sessions.storage"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: LIBSQL }));
		await assert.rejects(resolveSessionStore(project, { agentDir }), isLibsqlRemoval("settings", "storage"));
		await assert.rejects(getTeamProfile({ agentDir, cwd: project }), isLibsqlRemoval("settings", "storage"));
		const out: string[] = [];
		const code = await runStorageCommand(["status", "--json"], {
			cwd: project,
			agentDir,
			log: (line) => out.push(line),
			error: () => {},
		});
		assert.equal(code, 1);
		const status: StorageStatus = JSON.parse(out.join("\n"));
		for (const domain of status.domains) {
			assert.equal(domain.selection, "invalid");
			assert.match(domain.error ?? "", /\(libsql-removed\)/);
		}
		assert.deepEqual(readdirSync(agentDir), ["settings.json"]);
	});

	test("in createAgentSession({ storage }) is a config error naming the option", async () => {
		await assert.rejects(
			createAgentSession({ cwd: project, agentDir, storage: LIBSQL, builtins: NO_BUILTINS }),
			isLibsqlRemoval("sdk", "storage"),
		);
	});
});

describe("in-memory secrets (#4320)", () => {
	test("an in-memory secret never serializes, inspects or spreads (#4320)", () => {
		const selection = selectStorage(
			{ adapter: "x", options: { url: "postgres://db" }, secrets: { password: inMemorySecret("memory-secret") } },
			"sdk",
			"storage",
			"",
		);
		assert.ok(selection.kind === "adapter");
		const secret = selection.secrets?.password;
		assert.ok(secret !== undefined && "value" in secret);
		assert.equal(secret.value, "memory-secret");
		assert.equal(JSON.stringify(secret), JSON.stringify({ value: REDACTED_SECRET }));
		assert.doesNotMatch(JSON.stringify(selection), /memory-secret/);
		assert.doesNotMatch(inspect(selection, { depth: 5 }), /memory-secret/);
		assert.deepEqual({ ...secret }, {});
	});

	test("an in-memory secret is refused from settings and process JSON, and never reaches status output (#4320)", async () => {
		const settingsForm = { adapter: "x", secrets: { password: { value: "settings-secret" } } };
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

		vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ adapter: "x", secrets: { password: { value: "status-secret" } } }));
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
		assert.doesNotMatch(`${out.join("\n")}${err.join("\n")}`, /status-secret/);
	});

	test("in-memory secrets key open connections by identity, not by value (#4320)", () => {
		const first = inMemorySecret("identity-secret");
		const second = inMemorySecret("identity-secret");
		const key = (secret: ReturnType<typeof inMemorySecret>) =>
			storageSelectionKey({ kind: "adapter", module: "x", secrets: { password: secret } }, agentDir);
		assert.equal(key(first), key(first));
		assert.notEqual(key(first), key(second));
		assert.doesNotMatch(key(first), /identity-secret/);
	});

	test("an in-memory secret reaches the adapter's options, and secret order never changes the connection key (#4320)", async () => {
		const options = await resolveAdapterOptions(
			{
				kind: "adapter",
				module: "x",
				options: { url: "postgres://db" },
				secrets: { password: inMemorySecret("resolved") },
			},
			{ agentDir, domain: "sessions" },
		);
		assert.deepEqual({ ...options }, { url: "postgres://db", password: "resolved" });
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

	test("an in-memory secret shows as the documented [redacted] placeholder (#4320)", () => {
		assert.equal(REDACTED_SECRET, "[redacted]");
		assert.equal(JSON.stringify(inMemorySecret("team-secret-token")), '{"value":"[redacted]"}');
	});
});

test("a --storage flag outranks ATOMIC_STORAGE for the broker too (#4320)", () => {
	vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ path: join(root, "env.sqlite") }));
	setCliStorageSelection({ flag: "--storage", value: JSON.stringify({ path: join(root, "flag.sqlite") }) }, project);
	try {
		assert.deepEqual(JSON.parse(processSharedStorageSelection() ?? "null"), { path: join(root, "flag.sqlite") });
		assert.equal(processStorageEnvironment().ATOMIC_STORAGE, JSON.stringify({ path: join(root, "flag.sqlite") }));
	} finally {
		setCliStorageSelection(undefined);
	}
	vi.stubEnv("ATOMIC_STORAGE", "");
	assert.equal(processStorageEnvironment().ATOMIC_STORAGE, "");
});
