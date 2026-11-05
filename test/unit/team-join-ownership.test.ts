import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { getAgentDir } from "../../packages/coding-agent/src/config.js";
import type { IntercomBrokerControl } from "../../packages/coding-agent/src/core/intercom-broker-control.js";
import { FileSettingsStorage } from "../../packages/coding-agent/src/core/settings-storage.js";
import { isTeamProfileError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	LIBSQL_ADAPTER_PACKAGE,
	LOCAL_SESSIONS_STORAGE,
	STORAGE_TOKEN_FILE,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import {
	joinSharedDatabase,
	leaveTeamWith,
	storageFingerprint,
} from "../../packages/coding-agent/src/core/storage/team.js";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

const LIBSQL_SCENARIO_TIMEOUT_MS = 60_000;
const packageRoot = resolve(moduleDir(import.meta.url), "../../packages/storage-libsql");
const TOKEN = "team-secret-token";
const control = { restartIntercomBroker: async () => ({ status: "not-running" }) } as unknown as IntercomBrokerControl;
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

let root: string;
let agentDir: string;
let project: string;
let settingsPath: string;
let databaseDirectory: string;
let databaseUrl: string;

beforeEach(async () => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("team-ownership-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	settingsPath = join(agentDir, "settings.json");
	databaseDirectory = makeLibsqlDirectory();
	const path = join(databaseDirectory, "team.sqlite");
	databaseUrl = pathToFileURL(path).href;
	await (await openNodeSqliteDatabase(path)).close();
	writeFileSync(settingsPath, JSON.stringify({ theme: "dark", packages: [packageRoot] }, null, 2));
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await removeLibsqlDirectory(databaseDirectory);
	removeTempDirectory(root);
});

function joinTeamDatabase(options: { pinLocalSessions?: boolean; prefix?: string } = {}) {
	return joinSharedDatabase(
		{ url: databaseUrl, token: TOKEN, agentDir, cwd: project, pinLocalSessions: true, ...options },
		"sdk",
	);
}

function leave(onLeft?: () => void) {
	return leaveTeamWith(
		{ agentDir, cwd: project },
		{ loadControl: async () => control, ...(onLeft ? { onLeft } : {}) },
	);
}

function settingsText(): string {
	return readFileSync(settingsPath, "utf8");
}

function editStorage(edit: (storage: { options: Record<string, unknown>; prefix?: string }) => void): void {
	const settings = JSON.parse(settingsText());
	edit(settings.storage);
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

describe("team leave removes only the selection the join wrote (#4320)", () => {
	test(
		"a join followed by a leave restores the settings from before the join, record included",
		async () => {
			const before = JSON.parse(settingsText());
			const joined = await joinTeamDatabase();
			assert.ok(joined.tokenPath);

			const left = await leave();

			assert.deepEqual(left.removed, ["storage", "sessions.storage"]);
			assert.deepEqual(left.deletedTokenFiles, [joined.tokenPath]);
			assert.deepEqual(JSON.parse(settingsText()), before);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a changed URL or prefix of the same shape stays, with its token file, byte for byte",
		async () => {
			const edits: [string, (storage: { options: Record<string, unknown>; prefix?: string }) => void][] = [
				[
					"url",
					(storage) => {
						storage.options.url = "libsql://other.example.turso.io";
					},
				],
				[
					"prefix",
					(storage) => {
						storage.prefix = "mine_";
					},
				],
			];
			for (const [name, edit] of edits) {
				writeFileSync(settingsPath, JSON.stringify({ theme: "dark", packages: [packageRoot] }, null, 2));
				const joined = await joinTeamDatabase();
				assert.ok(joined.tokenPath);
				editStorage(edit);
				const edited = settingsText();
				const onLeft = vi.fn();

				const left = await leave(onLeft);

				assert.deepEqual(left.removed, [], name);
				assert.deepEqual(
					left.kept,
					[
						{ key: "storage", reason: "changed" },
						{ key: "sessions.storage", reason: "storage-remains" },
					],
					name,
				);
				assert.deepEqual(left.deletedTokenFiles, [], name);
				assert.equal(settingsText(), edited, name);
				assert.equal(existsSync(joined.tokenPath), true, name);
				assert.equal(onLeft.mock.calls.length, 0, name);
			}
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"the same selection with its keys in another order is still the join's value",
		async () => {
			const joined = await joinTeamDatabase({ prefix: "team_" });
			assert.ok(joined.tokenPath);
			const settings = JSON.parse(settingsText());
			const reordered = Object.fromEntries(Object.entries(settings.storage).reverse());
			writeFileSync(settingsPath, JSON.stringify({ ...settings, storage: reordered }, null, 2));

			const left = await leave();

			assert.deepEqual(left.removed, ["storage", "sessions.storage"]);
			assert.deepEqual(left.deletedTokenFiles, [joined.tokenPath]);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a join-shaped selection with no join record is kept, because nothing proves the join wrote it",
		async () => {
			await joinTeamDatabase();
			const { teamJoin: _record, ...unrecorded } = JSON.parse(settingsText());
			writeFileSync(settingsPath, JSON.stringify(unrecorded, null, 2));
			const before = settingsText();

			const left = await leave();

			assert.deepEqual(left.removed, []);
			assert.deepEqual(left.kept, [
				{ key: "storage", reason: "changed" },
				{ key: "sessions.storage", reason: "storage-remains" },
			]);
			assert.equal(settingsText(), before);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a storage join without the sessions pin writes no join record and leaves an existing one alone",
		async () => {
			await joinTeamDatabase({ pinLocalSessions: false });
			assert.equal(JSON.parse(settingsText()).teamJoin, undefined);

			await joinTeamDatabase();
			const record = JSON.parse(settingsText()).teamJoin;
			assert.equal(typeof record.storage, "string");

			await joinTeamDatabase({ pinLocalSessions: false, prefix: "other_" });
			assert.deepEqual(JSON.parse(settingsText()).teamJoin, record);
			const left = await leave();
			assert.deepEqual(left.removed, []);
			assert.deepEqual(left.kept[0], { key: "storage", reason: "changed" });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"the join record holds a fingerprint, never the selection, its token reference or the token",
		async () => {
			const joined = await joinTeamDatabase();
			assert.ok(joined.tokenPath);

			const record = JSON.stringify(JSON.parse(settingsText()).teamJoin);

			assert.match(record, /^\{"storage":"sha256:[\da-f]{64}"\}$/);
			assert.equal(record.includes(TOKEN), false);
			assert.equal(record.includes(STORAGE_TOKEN_FILE), false);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});

describe("team leave and global settings that the default agent directory also reads (#4320)", () => {
	const remote = { adapter: LIBSQL_ADAPTER_PACKAGE, options: { url: "libsql://legacy.example.turso.io" } };
	let legacySettings: string;

	function useDefaultAgentDirectory(): void {
		vi.stubEnv("HOME", root);
		vi.stubEnv("USERPROFILE", root);
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", undefined);
		vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
		agentDir = getAgentDir();
		assert.equal(agentDir, join(root, ".atomic", "agent"));
		settingsPath = join(agentDir, "settings.json");
		legacySettings = join(root, ".pi", "agent", "settings.json");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dirname(legacySettings), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ packages: [packageRoot] }, null, 2));
	}

	test(
		"a remote storage left in the legacy global settings keeps the local sessions pin",
		async () => {
			useDefaultAgentDirectory();
			await joinTeamDatabase();
			writeFileSync(legacySettings, JSON.stringify({ storage: remote }));

			const left = await leave();

			assert.deepEqual(left.removed, ["storage"]);
			assert.deepEqual(left.kept, [{ key: "sessions.storage", reason: "storage-remains" }]);
			assert.deepEqual(JSON.parse(settingsText()).sessions, { storage: LOCAL_SESSIONS_STORAGE });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a token file the legacy global settings still reference is kept",
		async () => {
			useDefaultAgentDirectory();
			const joined = await joinTeamDatabase();
			assert.ok(joined.tokenPath);
			writeFileSync(legacySettings, JSON.stringify({ workflows: { journal: joined.storage } }));

			const left = await leave();

			assert.deepEqual(left.removed, ["storage", "sessions.storage"]);
			assert.deepEqual(left.keptTokenFiles, [joined.tokenPath]);
			assert.equal(existsSync(joined.tokenPath), true);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"an unreadable legacy global settings file fails the leave before anything changes",
		async () => {
			useDefaultAgentDirectory();
			const joined = await joinTeamDatabase();
			assert.ok(joined.tokenPath);
			writeFileSync(legacySettings, "{not json");
			const before = settingsText();

			const failure = await leave().then(
				() => assert.fail("left"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.deepEqual([failure.code, failure.subject], ["settings-unreadable", legacySettings]);
			assert.equal(settingsText(), before);
			assert.equal(existsSync(joined.tokenPath), true);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a legacy global settings file that breaks after the preflight fails the leave naming that file",
		async () => {
			useDefaultAgentDirectory();
			const joined = await joinTeamDatabase();
			assert.ok(joined.tokenPath);
			const before = settingsText();
			const lock = FileSettingsStorage.prototype.withPrimaryWriteLock;
			vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock").mockImplementation(function (
				this: FileSettingsStorage,
				...args
			) {
				writeFileSync(legacySettings, "{not json");
				return lock.apply(this, args);
			});

			const failure = await leave().then(
				() => assert.fail("left"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.deepEqual([failure.code, failure.subject], ["settings-unreadable", legacySettings]);
			assert.equal(settingsText(), before);
			assert.equal(existsSync(joined.tokenPath), true);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a custom agent directory ignores the legacy global settings, as the settings loader does",
		async () => {
			vi.stubEnv("HOME", root);
			const joined = await joinTeamDatabase();
			assert.ok(joined.tokenPath);
			const legacy = join(root, ".pi", "agent", "settings.json");
			mkdirSync(dirname(legacy), { recursive: true });
			writeFileSync(legacy, JSON.stringify({ storage: remote }));
			new ProjectTrustStore(agentDir).set(project, true);

			const left = await leave();

			assert.deepEqual(left.removed, ["storage", "sessions.storage"]);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});

describe("the join record's fingerprint format (#4320)", () => {
	type Selection = Parameters<typeof storageFingerprint>[0];
	const tokenReference = "agent/storage-token.00000000-0000-4000-8000-000000000000";
	const selection = {
		prefix: "team_",
		options: {
			url: "libsql://db.example.turso.io",
			tls: false,
			tags: ["b", null, { z: 1, a: [2, "x"], skipped: undefined }],
			nested: { zeta: true, alpha: null, skipped: undefined },
		},
		adapter: "@bastani/atomic-storage-libsql",
		secrets: { authToken: { file: tokenReference } },
		skipped: undefined,
	} as unknown as Selection;
	const canonical =
		'{"adapter":"@bastani/atomic-storage-libsql","options":{"nested":{"alpha":null,"zeta":true},"tags":["b",null,{"a":[2,"x"],"z":1}],"tls":false,"url":"libsql://db.example.turso.io"},"prefix":"team_","secrets":{"authToken":{"file":"agent/storage-token.00000000-0000-4000-8000-000000000000"}}}';
	const digest = "6d92334de5e1bcc3a2efaf577cc2c9b9fb3b76eabffb8eb1ff60d97cdff212a2";

	test("is the sha256 of the key-sorted, whitespace-free JSON, with undefined entries left out", () => {
		assert.equal(createHash("sha256").update(canonical).digest("hex"), digest);
		assert.equal(storageFingerprint(selection), `sha256:${digest}`);
	});

	test("does not depend on object key order, but does on array order and on every value", () => {
		const reorder = (value: unknown): unknown =>
			Array.isArray(value)
				? value.map(reorder)
				: value !== null && typeof value === "object"
					? Object.fromEntries(
							Object.entries(value)
								.reverse()
								.map(([key, entry]) => [key, reorder(entry)]),
						)
					: value;
		assert.equal(storageFingerprint(reorder(selection) as Selection), `sha256:${digest}`);

		const edits: Selection[] = [
			{ ...selection, prefix: "other_" },
			{ ...selection, options: { ...selection.options, url: "libsql://db.example.turso.io/" } },
			{
				...selection,
				options: { ...selection.options, tags: [null, "b", { z: 1, a: [2, "x"] }] },
			} as unknown as Selection,
			{ ...selection, secrets: { authToken: { file: `${tokenReference}0` } } },
		];
		for (const edit of edits) assert.notEqual(storageFingerprint(edit), `sha256:${digest}`);
	});

	test(
		"a null, array or nested option edited into the saved selection is kept byte for byte through a leave",
		async () => {
			const edits = [
				(options: Record<string, unknown>) => void Object.assign(options, { url: ["libsql://a.example.io"] }),
				(options: Record<string, unknown>) => void Object.assign(options, { url: null }),
				(options: Record<string, unknown>) => void Object.assign(options, { extra: { inner: [null, 1] } }),
			];
			for (const edit of edits) {
				writeFileSync(settingsPath, JSON.stringify({ theme: "dark", packages: [packageRoot] }, null, 2));
				const joined = await joinTeamDatabase();
				assert.ok(joined.tokenPath);
				editStorage((storage) => edit(storage.options));
				const edited = settingsText();

				const left = await leave();

				assert.deepEqual(left.removed, [], edited);
				assert.deepEqual(left.kept[0], { key: "storage", reason: "changed" });
				assert.equal(settingsText(), edited);
				assert.equal(existsSync(joined.tokenPath), true);
			}
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});
