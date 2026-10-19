import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore, selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import { StorageConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	hasProcessStorageSelection,
	SESSIONS_STORAGE_ENV,
	STORAGE_ENV,
	selectProcessStorage,
	setCliStorageSelection,
	WORKFLOW_JOURNAL_PATH_ENV,
	WORKFLOWS_JOURNAL_ENV,
} from "../../packages/coding-agent/src/core/storage/process-selection.js";
import { buildInteractiveEngineArgs } from "../../packages/coding-agent/src/modes/interactive-engine/engine-args.js";
import { restartCliArgs } from "../../packages/coding-agent/src/modes/rpc/rpc-client-process.js";
import { resolvePath } from "../../packages/coding-agent/src/utils/paths.js";
import { resolveRunJournal, selectRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const SESSION_DIR_ENV = "ATOMIC_CODING_AGENT_SESSION_DIR";
const ADAPTER = join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts");

let root: string;
let agentDir: string;
let project: string;

beforeEach(() => {
	root = makeTempDirectory("process-storage-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	for (const name of [
		STORAGE_ENV,
		SESSIONS_STORAGE_ENV,
		WORKFLOWS_JOURNAL_ENV,
		WORKFLOW_JOURNAL_PATH_ENV,
		SESSION_DIR_ENV,
	])
		vi.stubEnv(name, "");
});

afterEach(() => {
	setCliStorageSelection(undefined);
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function storageFlag(json: object): void {
	setCliStorageSelection({ flag: "--storage", value: JSON.stringify(json) }, project);
}

function assertConfigError(action: () => object, source: "cli" | "env", field: string, reason: string): void {
	assert.throws(action, (error: Error) => {
		assert.ok(error instanceof StorageConfigError);
		assert.deepEqual([error.source, error.field, error.reason], [source, field, reason]);
		return true;
	});
}

async function assertConfigRejection(
	action: () => Promise<object>,
	source: "cli" | "env",
	field: string,
	reason: string,
): Promise<StorageConfigError> {
	try {
		await action();
	} catch (error) {
		assert.ok(error instanceof StorageConfigError);
		assert.deepEqual([error.source, error.field, error.reason], [source, field, reason]);
		return error;
	}
	assert.fail("expected a StorageConfigError");
}

test("session storage follows SDK, session flags, --storage, session variables, ATOMIC_STORAGE, then settings (#3783)", () => {
	const settings = {
		sessions: { storage: { path: "settings-sessions.sqlite" } },
		storage: { path: "settings-shared.sqlite" },
	};
	const select = (options: Parameters<typeof selectSessionStorage>[1] = {}) =>
		selectSessionStorage(project, { agentDir, settings, ...options });
	vi.stubEnv(STORAGE_ENV, JSON.stringify({ path: "shared-env.sqlite" }));
	vi.stubEnv(SESSIONS_STORAGE_ENV, JSON.stringify({ path: "sessions-env.sqlite", prefix: "env_" }));
	storageFlag({ path: "cli.sqlite" });
	const sdk = { kind: "memory" } as const;
	assert.equal(select({ sessionStore: sdk }), sdk);
	assert.deepEqual(select({ sessionStorePath: "store.sqlite" }), {
		kind: "sqlite",
		path: join(project, "store.sqlite"),
	});
	assert.deepEqual(select({ noSession: true }), { kind: "memory" });
	assert.deepEqual(select({ sessionDir: "dir" }), { kind: "jsonl", dir: join(project, "dir") });
	assert.deepEqual(select(), { kind: "sqlite", path: join(root, "cli.sqlite") });
	setCliStorageSelection(undefined);
	assert.deepEqual(select(), { kind: "sqlite", path: join(root, "sessions-env.sqlite"), prefix: "env_" });
	vi.stubEnv(SESSIONS_STORAGE_ENV, JSON.stringify({ dir: "env-sessions" }));
	assert.deepEqual(select(), { kind: "jsonl", dir: join(root, "env-sessions") });
	vi.stubEnv(SESSIONS_STORAGE_ENV, "");
	assert.deepEqual(select(), { kind: "sqlite", path: join(root, "shared-env.sqlite") });
	vi.stubEnv(SESSION_DIR_ENV, "legacy-sessions");
	assert.deepEqual(select(), { kind: "jsonl", dir: join(project, "legacy-sessions") });
	vi.stubEnv(SESSION_DIR_ENV, "");
	vi.stubEnv(STORAGE_ENV, JSON.stringify({}));
	assert.deepEqual(select(), { kind: "sqlite", path: join(root, "storage.sqlite") });
	assert.equal(hasProcessStorageSelection("sessions"), true);
	vi.stubEnv(STORAGE_ENV, "");
	assert.equal(hasProcessStorageSelection("sessions"), false);
	assert.deepEqual(select(), { kind: "sqlite", path: join(root, "settings-sessions.sqlite") });
});

test("the workflow journal follows SDK journal, --storage, journal variables, ATOMIC_STORAGE, then settings (#3783)", () => {
	const settings = {
		workflows: { journal: { path: "settings-journal.sqlite" } },
		storage: { path: "settings-shared.sqlite" },
	};
	vi.stubEnv(STORAGE_ENV, JSON.stringify({ path: "shared-env.sqlite" }));
	vi.stubEnv(WORKFLOWS_JOURNAL_ENV, JSON.stringify({ memory: true }));
	storageFlag({ path: "cli.sqlite", prefix: "cli_" });
	assert.deepEqual(selectRunJournal({ journal: { path: "sdk.sqlite" }, settings }), {
		kind: "sqlite",
		path: "sdk.sqlite",
	});
	assert.deepEqual(selectRunJournal({ settings }), { kind: "sqlite", path: join(root, "cli.sqlite"), prefix: "cli_" });
	setCliStorageSelection(undefined);
	assert.deepEqual(selectRunJournal({ settings }), { kind: "memory" });
	vi.stubEnv(WORKFLOWS_JOURNAL_ENV, JSON.stringify({}));
	assert.deepEqual(selectRunJournal({ settings }), {
		kind: "sqlite",
		path: join(root, "workflows", "journal.sqlite"),
	});
	vi.stubEnv(WORKFLOWS_JOURNAL_ENV, "");
	assert.deepEqual(selectRunJournal({ settings }), { kind: "sqlite", path: join(root, "shared-env.sqlite") });
	vi.stubEnv(WORKFLOW_JOURNAL_PATH_ENV, "legacy.sqlite");
	assert.deepEqual(selectRunJournal({ settings }), { kind: "sqlite", path: "legacy.sqlite" });
	vi.stubEnv(WORKFLOW_JOURNAL_PATH_ENV, "");
	vi.stubEnv(STORAGE_ENV, "");
	assert.deepEqual(selectRunJournal({ settings }), { kind: "sqlite", path: join(root, "settings-journal.sqlite") });
});

test("session flags beat --storage for sessions while --storage still selects the journal (#3783)", () => {
	vi.stubEnv(SESSION_DIR_ENV, "legacy-sessions");
	const parsed = parseArgs(["--session-dir", "flag-sessions", "--storage", JSON.stringify({ path: "cli.sqlite" })]);
	setCliStorageSelection(parsed.storage, project);
	assert.deepEqual(selectSessionStorage(project, { agentDir, sessionDir: parsed.sessionDir }), {
		kind: "jsonl",
		dir: join(project, "flag-sessions"),
	});
	assert.deepEqual(selectRunJournal(), { kind: "sqlite", path: join(root, "cli.sqlite") });
});

test("--storage and --storage-file are exclusive, need a value, and read files relative to the working directory (#3783)", async () => {
	for (const args of [
		["--storage", "{}", "--storage-file", "selection.json"],
		["--storage-file", "selection.json", "--storage", "{}"],
	]) {
		assertConfigError(() => parseArgs(args), "cli", "--storage, --storage-file", "conflicting-flags");
	}
	assertConfigError(() => parseArgs(["--storage"]), "cli", "--storage", "selection-required");
	assertConfigError(() => parseArgs(["--storage-file"]), "cli", "--storage-file", "path-required");
	assert.deepEqual(parseArgs(["--storage", "{}"]).storage, { flag: "--storage", value: "{}" });
	await writeFileEnsuringDir(join(project, "selection.json"), JSON.stringify({ path: "from-file.sqlite" }));
	setCliStorageSelection(parseArgs(["--storage-file", "selection.json"]).storage, project);
	assert.deepEqual(selectRunJournal(), { kind: "sqlite", path: join(root, "from-file.sqlite") });
	assert.deepEqual(selectSessionStorage(project, { agentDir }), {
		kind: "sqlite",
		path: join(root, "from-file.sqlite"),
	});
	assertConfigError(
		() => {
			setCliStorageSelection({ flag: "--storage-file", value: "missing.json" }, project);
			return {};
		},
		"cli",
		"--storage-file",
		"unreadable-file",
	);
	assert.equal(hasProcessStorageSelection("journal"), false);
});

test("invalid JSON and invalid selections name their variable or flag without echoing the value (#3783)", async () => {
	const secret = "s3cr3t-3783-value";
	const malformed = `{"adapter":"x","options":{"token":"${secret}"`;
	const misspelled = JSON.stringify({ adpater: "x", options: { token: secret } });
	const cases: Array<[string, () => object]> = [
		[STORAGE_ENV, () => selectSessionStorage(project, { agentDir })],
		[SESSIONS_STORAGE_ENV, () => selectSessionStorage(project, { agentDir })],
		[WORKFLOWS_JOURNAL_ENV, () => selectRunJournal()],
	];
	for (const [name, select] of cases) {
		for (const [text, reason] of [
			[malformed, "invalid-json"],
			[misspelled, "invalid-selection"],
		] as const) {
			vi.stubEnv(name, text);
			assert.throws(select, (error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.deepEqual([error.source, error.field, error.reason], ["env", name, reason]);
				assert.equal(error.message.includes(secret), false);
				assert.equal(error.cause, undefined);
				return true;
			});
		}
		vi.stubEnv(name, "");
	}
	vi.stubEnv(STORAGE_ENV, JSON.stringify({ dir: "sessions" }));
	assertConfigError(() => selectSessionStorage(project, { agentDir }), "env", STORAGE_ENV, "invalid-selection");
	vi.stubEnv(STORAGE_ENV, "");
	vi.stubEnv(WORKFLOWS_JOURNAL_ENV, JSON.stringify({ dir: "runs" }));
	assertConfigError(() => selectRunJournal(), "env", WORKFLOWS_JOURNAL_ENV, "invalid-selection");
	for (const [text, reason] of [
		[malformed, "invalid-json"],
		[misspelled, "invalid-selection"],
	] as const) {
		assertConfigError(
			() => {
				setCliStorageSelection({ flag: "--storage", value: text }, project);
				return {};
			},
			"cli",
			"--storage",
			reason,
		);
		await writeFileEnsuringDir(join(project, "bad.json"), text);
		assertConfigError(
			() => {
				setCliStorageSelection({ flag: "--storage-file", value: "bad.json" }, project);
				return {};
			},
			"cli",
			"--storage-file",
			reason,
		);
	}
});

test("a set storage variable outranked by another selection still fails when invalid (#3783)", () => {
	const secret = "s3cr3t-3783-shadowed";
	const malformed = `{"adapter":"x","options":{"token":"${secret}"`;
	const misspelled = JSON.stringify({ adpater: "x", options: { token: secret } });
	const selections: Array<[string, () => object]> = [
		["sessions", () => selectProcessStorage("sessions", agentDir, project) ?? {}],
		["journal", () => selectProcessStorage("journal", agentDir, project) ?? {}],
		["SDK sessions", () => selectSessionStorage(project, { agentDir })],
		["workflow journal", () => selectRunJournal()],
	];
	const scenarios: Array<[string, Record<string, string>, boolean]> = [
		[STORAGE_ENV, {}, true],
		[
			STORAGE_ENV,
			{ [SESSIONS_STORAGE_ENV]: JSON.stringify({ memory: true }), [WORKFLOWS_JOURNAL_ENV]: JSON.stringify({}) },
			false,
		],
		[SESSIONS_STORAGE_ENV, {}, true],
		[WORKFLOWS_JOURNAL_ENV, {}, true],
	];
	for (const [name, others, withFlag] of scenarios) {
		for (const [text, reason] of [
			[malformed, "invalid-json"],
			[misspelled, "invalid-selection"],
			[JSON.stringify({ path: "file:///%E0.sqlite" }), "invalid-path"],
		] as const) {
			for (const [other, value] of Object.entries(others)) vi.stubEnv(other, value);
			if (withFlag) storageFlag({ memory: true });
			vi.stubEnv(name, text);
			for (const [label, select] of selections) {
				assert.throws(select, (error: Error) => {
					assert.ok(error instanceof StorageConfigError, label);
					assert.deepEqual([error.source, error.field, error.reason], ["env", name, reason], label);
					assert.equal(error.message.includes(secret), false, label);
					return true;
				});
			}
			setCliStorageSelection(undefined);
			for (const other of [name, ...Object.keys(others)]) vi.stubEnv(other, "");
		}
	}
});

test("explicit overrides of one domain conflict instead of one silently winning (#3783)", () => {
	vi.stubEnv(SESSIONS_STORAGE_ENV, JSON.stringify({ memory: true }));
	vi.stubEnv(SESSION_DIR_ENV, "legacy-sessions");
	assertConfigError(
		() => selectSessionStorage(project, { agentDir }),
		"env",
		`${SESSIONS_STORAGE_ENV}, ${SESSION_DIR_ENV}`,
		"conflicting-overrides",
	);
	vi.stubEnv(WORKFLOWS_JOURNAL_ENV, JSON.stringify({ memory: true }));
	vi.stubEnv(WORKFLOW_JOURNAL_PATH_ENV, join(root, "legacy.sqlite"));
	assertConfigError(
		() => selectRunJournal(),
		"env",
		`${WORKFLOWS_JOURNAL_ENV}, ${WORKFLOW_JOURNAL_PATH_ENV}`,
		"conflicting-overrides",
	);
	vi.stubEnv(SESSIONS_STORAGE_ENV, "");
	vi.stubEnv(WORKFLOWS_JOURNAL_ENV, "");
	storageFlag({ memory: true });
	assertConfigError(
		() => selectSessionStorage(project, { agentDir }),
		"cli",
		`--storage, ${SESSION_DIR_ENV}`,
		"conflicting-overrides",
	);
	assertConfigError(
		() => selectRunJournal(),
		"cli",
		`--storage, ${WORKFLOW_JOURNAL_PATH_ENV}`,
		"conflicting-overrides",
	);
	assert.deepEqual(selectSessionStorage(project, { agentDir, sessionDir: "flag" }), {
		kind: "jsonl",
		dir: join(project, "flag"),
	});
	assert.deepEqual(selectRunJournal({ journal: { memory: true } }), { kind: "memory" });
});

test("process adapter selections resolve { env } and { file } secrets and never report their values (#3783)", async () => {
	const envSecret = "env-secret-3783";
	const fileSecret = "file-secret-3783";
	vi.stubEnv("ISSUE_3783_TOKEN", envSecret);
	await writeFileEnsuringDir(join(root, "password.txt"), fileSecret);
	const adapter = (path: string, secrets: object) => JSON.stringify({ adapter: ADAPTER, options: { path }, secrets });
	vi.stubEnv(SESSIONS_STORAGE_ENV, adapter(join(root, "sessions.sqlite"), { token: { env: "ISSUE_3783_TOKEN" } }));
	vi.stubEnv(WORKFLOWS_JOURNAL_ENV, adapter(join(root, "journal.sqlite"), { password: { file: "password.txt" } }));
	const sessions = await resolveSessionStore(project, { agentDir });
	const journal = await resolveRunJournal();
	await sessions.close();
	await journal.close();
	await writeFileEnsuringDir(
		join(project, "selection.json"),
		adapter(join(root, "cli.sqlite"), { token: { env: "ISSUE_3783_TOKEN" } }),
	);
	setCliStorageSelection({ flag: "--storage-file", value: "selection.json" }, project);
	await (await resolveSessionStore(project, { agentDir })).close();
	const probes: Record<string, string> = {};
	for (const name of ["sessions", "journal", "cli"]) {
		const database = await openNodeSqliteDatabase(join(root, `${name}.sqlite`));
		const row = await database.get("SELECT options, domain FROM adapter_probe");
		await database.close();
		probes[name] = `${row?.domain}:${row?.options}`;
	}
	assert.ok(probes.sessions?.startsWith("sessions:") && probes.sessions.includes(`"token":"${envSecret}"`));
	assert.ok(probes.journal?.startsWith("journal:") && probes.journal.includes(`"password":"${fileSecret}"`));
	assert.ok(probes.cli?.startsWith("sessions:") && probes.cli.includes(`"token":"${envSecret}"`));

	setCliStorageSelection(undefined);
	vi.stubEnv(SESSIONS_STORAGE_ENV, "");
	vi.stubEnv(WORKFLOWS_JOURNAL_ENV, "");
	vi.stubEnv(
		STORAGE_ENV,
		adapter(join(root, "missing.sqlite"), {
			token: { env: "ISSUE_3783_TOKEN" },
			missing: { env: "ISSUE_3783_UNSET" },
		}),
	);
	for (const open of [() => resolveSessionStore(project, { agentDir }), () => resolveRunJournal()]) {
		const error = await assertConfigRejection(open, "env", STORAGE_ENV, "secret-env-missing");
		assert.equal(error.message.includes(envSecret), false);
	}
});

test("the interactive engine child receives the --storage selection and engine restarts keep it (#3783)", () => {
	const selection = JSON.stringify({ path: "cli.sqlite" });
	const fromFlag = parseArgs(
		buildInteractiveEngineArgs(parseArgs(["--storage", selection]), SessionManager.inMemory(), {}),
	);
	assert.deepEqual(fromFlag.storage, { flag: "--storage", value: selection });
	const fromFile = parseArgs(
		buildInteractiveEngineArgs(parseArgs(["--storage-file", "selection.json"]), SessionManager.inMemory(), {}),
	);
	assert.deepEqual(fromFile.storage, { flag: "--storage-file", value: resolvePath("selection.json") });
	assert.deepEqual(parseArgs(restartCliArgs(["--storage", selection, "--no-session"], "next")).storage, {
		flag: "--storage",
		value: selection,
	});
});
