import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	defaultSessionDatabasePath,
	readClaimFile,
	sameDirectory,
	secretFilePath,
	storageHomeDir,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import { DefaultPackageManager } from "../../packages/coding-agent/src/core/package-manager.js";
import { resolveSessionStore, selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	isSameFile,
	resetStorageHomeCacheForTests,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";
import {
	selectProcessStorage,
	validateProcessStorage,
} from "../../packages/coding-agent/src/core/storage/process-selection.js";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { buildSessionMemoryGuideline } from "../../packages/coding-agent/src/core/system-prompt.js";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.js";
import { atomicHome } from "../../packages/coding-agent/src/core/workspace/resolve.js";
import { resolveBrokerStateSource } from "../../packages/intercom/broker/open-broker-state.js";

import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const STORAGE_ENV_KEYS = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_PROFILE",
] as const;

let root: string;
let project: string;

beforeEach(() => {
	resetStorageHomeCacheForTests();
	for (const key of STORAGE_ENV_KEYS) vi.stubEnv(key, "");
	root = makeTempDirectory("agent-dir-storage-isolation-");
	project = join(root, "project");
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

test("two sibling agent directories under one parent keep separate session and Intercom stores (#5242)", async () => {
	const first = join(root, "a1");
	const second = join(root, "a2");
	mkdirSync(first, { recursive: true });
	mkdirSync(second, { recursive: true });

	assert.deepEqual(selectSessionStorage(project, { agentDir: first, settings: {} }), {
		kind: "sqlite",
		path: join(first, "workflows", "journal.sqlite"),
	});
	assert.deepEqual(selectSessionStorage(project, { agentDir: second, settings: {} }), {
		kind: "sqlite",
		path: join(second, "workflows", "journal.sqlite"),
	});
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", first);
	assert.ok(buildSessionMemoryGuideline(["read"], project)?.includes(join(first, "workflows", "journal.sqlite")));

	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", second);
	assert.ok(buildSessionMemoryGuideline(["read"], project)?.includes(join(second, "workflows", "journal.sqlite")));

	const firstSessions = await resolveSessionStore(project, { agentDir: first, settings: {} });
	const secondSessions = await resolveSessionStore(project, { agentDir: second, settings: {} });
	try {
		await firstSessions.create(
			{
				id: "11111111-1111-4111-8111-111111111111",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
		assert.equal(
			(await firstSessions.readHeader("11111111-1111-4111-8111-111111111111"))?.id,
			"11111111-1111-4111-8111-111111111111",
		);
		assert.equal(await secondSessions.readHeader("11111111-1111-4111-8111-111111111111"), undefined);
	} finally {
		await firstSessions.close();
		await secondSessions.close();
	}

	const firstBrokerSource = await resolveBrokerStateSource({}, first);
	const secondBrokerSource = await resolveBrokerStateSource({}, second);
	assert.equal(firstBrokerSource.status, "shared");
	assert.equal(secondBrokerSource.status, "shared");
	if (firstBrokerSource.status === "shared" && secondBrokerSource.status === "shared") {
		const firstDb = await firstBrokerSource.source.openDatabase();
		const secondDb = await secondBrokerSource.source.openDatabase();
		try {
			assert.equal(firstDb.descriptor.location, join(first, "storage.sqlite"));
			assert.equal(secondDb.descriptor.location, join(second, "storage.sqlite"));
		} finally {
			await firstDb.close();
			await secondDb.close();
		}
	}

	const firstStatus = await collectStorageStatus({ cwd: project, agentDir: first, probe: true });
	const secondStatus = await collectStorageStatus({ cwd: project, agentDir: second, probe: true });
	assert.equal(
		firstStatus.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(first, "workflows", "journal.sqlite")}`,
	);
	assert.equal(
		secondStatus.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(second, "workflows", "journal.sqlite")}`,
	);
	assert.equal(existsSync(join(root, "workflows")), false);
});

test("default ~/.atomic/agent keeps reading its existing ~/.atomic/workflows store (#5242)", async () => {
	const home = join(root, "home");
	const atomicHome = join(home, ".atomic");
	const defaultAgent = join(atomicHome, "agent");
	mkdirSync(defaultAgent, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	const sessionId = "56565656-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const seeded = await resolveSessionStore(project, {
		agentDir: defaultAgent,
		sessionStore: { kind: "sqlite", path: join(atomicHome, "workflows", "journal.sqlite") },
	});
	try {
		await seeded.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: project }, []);
	} finally {
		await seeded.close();
	}

	for (const configured of [undefined, defaultAgent]) {
		resetStorageHomeCacheForTests();
		if (configured === undefined) {
			delete process.env.ATOMIC_CODING_AGENT_DIR;
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", configured);
		}
		const store = await resolveSessionStore(project, { agentDir: defaultAgent, settings: {} });
		try {
			assert.equal((await store.readHeader(sessionId))?.id, sessionId);
		} finally {
			await store.close();
		}
		assert.deepEqual(selectSessionStorage(project, { agentDir: defaultAgent, settings: {} }), {
			kind: "sqlite",
			path: join(atomicHome, "workflows", "journal.sqlite"),
		});
		assert.equal(secretFilePath("agent/storage-token.1", defaultAgent), join(atomicHome, "agent/storage-token.1"));
		const status = await collectStorageStatus({ cwd: project, agentDir: defaultAgent, probe: false });
		assert.equal(
			status.domains.find((entry) => entry.domain === "sessions")?.selection,
			`SQLite ${join(atomicHome, "workflows", "journal.sqlite")}`,
		);
		assert.deepEqual(status.notes, []);
	}
	assert.equal(existsSync(join(atomicHome, "workflows", ".adopted-by")), false);
});

test("a custom agent directory under ~/.atomic never adopts the default ~/.atomic/workflows store (#5242)", async () => {
	const home = join(root, "home");
	const atomicHome = join(home, ".atomic");
	const customSibling = join(atomicHome, "profile-2");
	mkdirSync(join(atomicHome, "workflows"), { recursive: true });
	mkdirSync(customSibling, { recursive: true });
	const db = new DatabaseSync(join(atomicHome, "workflows", "journal.sqlite"));
	db.close();
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", customSibling);

	assert.deepEqual(selectSessionStorage(project, { agentDir: customSibling, settings: {} }), {
		kind: "sqlite",
		path: join(customSibling, "workflows", "journal.sqlite"),
	});
	assert.equal(existsSync(join(atomicHome, "workflows", ".adopted-by")), false);
});

test("an existing parent store is adopted once by one directory, keeps working, emits a one-time notice, and is never adopted by a sibling (#5242)", async () => {
	const legacyWorkflows = join(root, "workflows");
	mkdirSync(legacyWorkflows, { recursive: true });
	const legacySessionsDb = new DatabaseSync(join(legacyWorkflows, "journal.sqlite"));
	legacySessionsDb.close();

	const first = join(root, "a1");
	const second = join(root, "a2");
	mkdirSync(first, { recursive: true });
	mkdirSync(second, { recursive: true });

	const firstStatus = await collectStorageStatus({ cwd: project, agentDir: first, probe: true });
	assert.equal(
		firstStatus.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(root, "workflows", "journal.sqlite")}`,
	);
	assert.equal(firstStatus.notes.length, 1);
	assert.match(firstStatus.notes[0] ?? "", /Adopted existing storage/);

	const firstStatusAgain = await collectStorageStatus({ cwd: project, agentDir: first, probe: true });
	assert.deepEqual(firstStatusAgain.notes, []);

	const secondStatus = await collectStorageStatus({ cwd: project, agentDir: second, probe: true });
	assert.equal(
		secondStatus.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(second, "workflows", "journal.sqlite")}`,
	);
	assert.deepEqual(secondStatus.notes, []);

	const firstSessions = await resolveSessionStore(project, { agentDir: first, settings: {} });
	const secondSessions = await resolveSessionStore(project, { agentDir: second, settings: {} });
	try {
		await firstSessions.create(
			{
				id: "22222222-2222-4222-8222-222222222222",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
		assert.equal(
			(await firstSessions.readHeader("22222222-2222-4222-8222-222222222222"))?.id,
			"22222222-2222-4222-8222-222222222222",
		);
		assert.equal(await secondSessions.readHeader("22222222-2222-4222-8222-222222222222"), undefined);
	} finally {
		await firstSessions.close();
		await secondSessions.close();
	}

	for (const entry of readdirSync(first)) rmSync(join(first, entry), { recursive: true, force: true });
	resetStorageHomeCacheForTests();
});

test("a directory that already has its own <agentDir>/workflows store never adopts a parent store created later (#5242)", async () => {
	const first = join(root, "a1");
	const second = join(root, "a2");
	mkdirSync(first, { recursive: true });
	mkdirSync(second, { recursive: true });

	const secondStore = await resolveSessionStore(project, { agentDir: second, settings: {} });
	await secondStore.close();
	assert.equal(existsSync(join(second, "workflows", "journal.sqlite")), true);

	mkdirSync(join(root, "workflows"), { recursive: true });
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	resetStorageHomeCacheForTests();

	assert.deepEqual(selectSessionStorage(project, { agentDir: second, settings: {} }), {
		kind: "sqlite",
		path: join(second, "workflows", "journal.sqlite"),
	});
	assert.equal(existsSync(join(root, "workflows", ".adopted-by")), false);

	assert.deepEqual(selectSessionStorage(project, { agentDir: first, settings: {} }), {
		kind: "sqlite",
		path: join(root, "workflows", "journal.sqlite"),
	});
	assert.equal(existsSync(join(root, "workflows", ".adopted-by")), true);

	vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ path: "rel.sqlite" }));
	assert.deepEqual(selectProcessStorage("sessions", first, project)?.selection, {
		kind: "sqlite",
		path: join(root, "rel.sqlite"),
	});
	assert.deepEqual(selectProcessStorage("sessions", second, project)?.selection, {
		kind: "sqlite",
		path: join(second, "rel.sqlite"),
	});
});

test("a symlink alias of ~/.atomic never lets a custom profile adopt the default store, and an alias of ~/.atomic/agent keeps ~/.atomic/workflows (#5242)", async () => {
	const home = join(root, "home");
	const atomicHomeDir = join(home, ".atomic");
	const defaultAgent = join(atomicHomeDir, "agent");
	mkdirSync(defaultAgent, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);

	const defaultSessions = await resolveSessionStore(project, { agentDir: defaultAgent, settings: {} });
	try {
		await defaultSessions.create(
			{
				id: "33333333-3333-4333-8333-333333333333",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await defaultSessions.close();
	}

	const homeAlias = join(root, "atomic-alias");
	symlinkSync(atomicHomeDir, homeAlias, "junction");
	const aliasedProfile = join(homeAlias, "profile");
	mkdirSync(aliasedProfile, { recursive: true });

	const profileSessions = await resolveSessionStore(project, { agentDir: aliasedProfile, settings: {} });
	try {
		assert.equal(await profileSessions.readHeader("33333333-3333-4333-8333-333333333333"), undefined);
	} finally {
		await profileSessions.close();
	}
	assert.equal(existsSync(join(atomicHomeDir, "workflows", ".adopted-by")), false);

	const agentAlias = join(root, "default-agent-alias");
	symlinkSync(defaultAgent, agentAlias, "junction");
	assert.equal(storageHomeDir(agentAlias), atomicHomeDir);
});

test("configured relative storage paths and secret files at the legacy parent are adopted once by one directory, while secrets remain readable (#5242)", async () => {
	const parent = join(root, "configured-legacy");
	const first = join(parent, "a1");
	const second = join(parent, "a2");
	mkdirSync(first, { recursive: true });
	mkdirSync(second, { recursive: true });

	const legacyTeamStore = await resolveSessionStore(project, {
		agentDir: first,
		sessionStore: { kind: "sqlite", path: join(parent, "team.sqlite") },
	});
	try {
		await legacyTeamStore.create(
			{
				id: "55555555-5555-4555-8555-555555555555",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await legacyTeamStore.close();
	}

	writeFileSync(join(parent, "turso-token"), "secret-value\n");
	const settings = { storage: { path: "team.sqlite" } };
	writeFileSync(join(first, "settings.json"), JSON.stringify(settings));
	writeFileSync(join(second, "settings.json"), JSON.stringify(settings));
	resetStorageHomeCacheForTests();

	const firstStore = await resolveSessionStore(project, { agentDir: first, settings });
	const secondStore = await resolveSessionStore(project, { agentDir: second, settings });
	try {
		assert.equal(
			(await firstStore.readHeader("55555555-5555-4555-8555-555555555555"))?.id,
			"55555555-5555-4555-8555-555555555555",
		);
		assert.equal(await secondStore.readHeader("55555555-5555-4555-8555-555555555555"), undefined);
	} finally {
		await firstStore.close();
		await secondStore.close();
	}
	assert.equal(secretFilePath("turso-token", first), join(parent, "turso-token"));
	assert.equal(secretFilePath("turso-token", second), join(parent, "turso-token"));

	const jsonlParent = join(root, "configured-jsonl");
	const jsonlFirst = join(jsonlParent, "a1");
	const jsonlSecond = join(jsonlParent, "a2");
	mkdirSync(join(jsonlParent, "custom-sessions"), { recursive: true });
	mkdirSync(jsonlFirst, { recursive: true });
	mkdirSync(jsonlSecond, { recursive: true });
	const jsonlSettings = { sessions: { storage: { dir: "custom-sessions" } } };
	writeFileSync(join(jsonlFirst, "settings.json"), JSON.stringify(jsonlSettings));
	writeFileSync(join(jsonlSecond, "settings.json"), JSON.stringify(jsonlSettings));
	assert.deepEqual(selectSessionStorage(project, { agentDir: jsonlFirst, settings: jsonlSettings }), {
		kind: "jsonl",
		dir: join(jsonlParent, "custom-sessions"),
	});
	assert.deepEqual(selectSessionStorage(project, { agentDir: jsonlSecond, settings: jsonlSettings }), {
		kind: "jsonl",
		dir: join(jsonlSecond, "custom-sessions"),
	});
});

test("custom agent directories directly under os.tmpdir() or ~/.atomic/agent adopt an existing parent store once (#5242)", () => {
	const customTmp = join(root, "custom-tmp");
	mkdirSync(join(customTmp, "workflows"), { recursive: true });
	writeFileSync(join(customTmp, "workflows", "journal.sqlite"), "");
	const tmpFirst = join(customTmp, "a1");
	const tmpSecond = join(customTmp, "a2");
	mkdirSync(tmpFirst, { recursive: true });
	mkdirSync(tmpSecond, { recursive: true });
	vi.stubEnv("TMPDIR", customTmp);
	vi.stubEnv("TEMP", customTmp);
	vi.stubEnv("TMP", customTmp);

	assert.equal(storageHomeDir(tmpFirst, {}), customTmp);
	assert.equal(storageHomeDir(tmpSecond, {}), tmpSecond);

	const home = join(root, "nested-home");
	const defaultAgent = join(home, ".atomic", "agent");
	const nestedFirst = join(defaultAgent, "dev");
	const nestedSecond = join(defaultAgent, "staging");
	mkdirSync(join(defaultAgent, "workflows"), { recursive: true });
	writeFileSync(join(defaultAgent, "workflows", "journal.sqlite"), "");
	mkdirSync(nestedFirst, { recursive: true });
	mkdirSync(nestedSecond, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);

	assert.equal(storageHomeDir(nestedFirst, {}), defaultAgent);
	assert.equal(storageHomeDir(nestedSecond, {}), nestedSecond);
});

test.skipIf(process.platform === "win32")(
	"an agent directory whose name ends with a space adopts an existing parent store without sharing it with a sibling (#5242)",
	async () => {
		const parent = join(root, "whitespace");
		const legacyHostId = "0b9f3c3e-6a8e-4f3c-9a4e-2f6d8c1b7a55";
		mkdirSync(join(parent, "workflows", "pool"), { recursive: true });
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
		writeFileSync(join(parent, "workflows", "pool", "host-id"), `${legacyHostId}\n`);
		const trailingSpaceDir = join(parent, "profile ");
		const siblingDir = join(parent, "sibling");
		mkdirSync(trailingSpaceDir, { recursive: true });
		mkdirSync(siblingDir, { recursive: true });

		assert.equal(storageHomeDir(trailingSpaceDir, {}), parent);
		assert.equal(storageHomeDir(siblingDir, {}), siblingDir);
	},
);

test("a relative agent directory resolves against the current working directory after process.chdir (#5242)", () => {
	const ws1 = join(root, "ws1");
	const ws2 = join(root, "ws2");
	mkdirSync(join(ws1, "profile", "workflows"), { recursive: true });
	writeFileSync(join(ws1, "profile", "workflows", "journal.sqlite"), "");
	mkdirSync(join(ws2, "profile", "workflows"), { recursive: true });
	writeFileSync(join(ws2, "profile", "workflows", "journal.sqlite"), "");
	const originalCwd = process.cwd();
	try {
		process.chdir(ws1);
		assert.equal(storageHomeDir("profile"), join(ws1, "profile"));
		process.chdir(ws2);
		assert.equal(storageHomeDir("profile"), join(ws2, "profile"));
	} finally {
		process.chdir(originalCwd);
	}
});

test("workspace shared repository stores and worktrees follow the isolated storage home and adopt an existing parent (#5242)", () => {
	const freshParent = join(root, "ws-fresh");
	const freshA1 = join(freshParent, "a1");
	const freshA2 = join(freshParent, "a2");
	mkdirSync(freshA1, { recursive: true });
	mkdirSync(freshA2, { recursive: true });

	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", freshA1);
	assert.equal(atomicHome(), freshA1);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", freshA2);
	assert.equal(atomicHome(), freshA2);

	const legacyParent = join(root, "ws-legacy");
	const legacyA1 = join(legacyParent, "a1");
	const legacyA2 = join(legacyParent, "a2");
	mkdirSync(join(legacyParent, "workflows"), { recursive: true });
	writeFileSync(join(legacyParent, "workflows", "journal.sqlite"), "");
	mkdirSync(join(legacyParent, "repos"), { recursive: true });
	mkdirSync(legacyA1, { recursive: true });
	mkdirSync(legacyA2, { recursive: true });

	assert.equal(storageHomeDir(legacyA1, {}), legacyParent);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", legacyA1);
	assert.equal(atomicHome(), legacyParent);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", legacyA2);
	assert.equal(atomicHome(), legacyA2);
});

test("legacy worker host-id claims preserve storage-home adoption by a single owner (#5242, #5219)", async () => {
	const parent1 = join(root, "host-id-align-1");
	const legacy1 = "11111111-2222-4333-8444-555555555555";
	mkdirSync(join(parent1, "workflows", "pool"), { recursive: true });
	writeFileSync(join(parent1, "workflows", "journal.sqlite"), "");
	writeFileSync(join(parent1, "workflows", "pool", "host-id"), `${legacy1}\n`);
	const a1 = join(parent1, "a1");
	const a2WithLocalStore = join(parent1, "a2");
	mkdirSync(a1, { recursive: true });
	mkdirSync(join(a2WithLocalStore, "workflows"), { recursive: true });
	writeFileSync(join(a2WithLocalStore, "workflows", "journal.sqlite"), "");
	assert.equal(storageHomeDir(a2WithLocalStore), a2WithLocalStore);
	assert.equal(storageHomeDir(a1), parent1);

	const parent2 = join(root, "host-id-align-2");
	const legacy2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
	mkdirSync(join(parent2, "workflows", "pool"), { recursive: true });
	writeFileSync(join(parent2, "workflows", "journal.sqlite"), "");
	writeFileSync(join(parent2, "workflows", "pool", "host-id"), `${legacy2}\n`);
	const b1 = join(parent2, "b1");
	const b2ClaimedHostId = join(parent2, "b2");
	mkdirSync(b1, { recursive: true });
	mkdirSync(b2ClaimedHostId, { recursive: true });
	writeFileSync(join(parent2, "workflows", "pool", "host-id.adopted-by"), `${b2ClaimedHostId}\n`);

	assert.equal(storageHomeDir(b1), b1);
	assert.equal(storageHomeDir(b2ClaimedHostId), parent2);
});

test("user workflow resource discovery skips top-level journal, pool, and runs store directories (#5242)", async () => {
	const agentDir = join(root, "resource-agent");
	const workflowsDir = join(agentDir, "workflows");
	const flowPath = join(workflowsDir, "flow.ts");
	mkdirSync(join(workflowsDir, "runs", "run-1"), { recursive: true });
	mkdirSync(join(workflowsDir, "pool", "worker-logs"), { recursive: true });
	mkdirSync(join(workflowsDir, "journal"), { recursive: true });
	writeFileSync(flowPath, "export default {};\n");
	writeFileSync(join(workflowsDir, "runs", "run-1", "notes.mjs"), "export default {};\n");
	writeFileSync(join(workflowsDir, "runs", "run-1", "helper.ts"), "export const x = 1;\n");
	writeFileSync(join(workflowsDir, "pool", "worker-logs", "x.js"), "export default {};\n");
	writeFileSync(join(workflowsDir, "journal", "x.ts"), "export default {};\n");

	const manager = new DefaultPackageManager({
		cwd: project,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
	});
	const resolved = await manager.resolve();
	assert.deepEqual(
		resolved.workflows.map((entry) => entry.path),
		[flowPath],
	);
});

test("generic parent directories such as repos, worktrees, unselected storage.sqlite, or bare workflows/runs and workflows/pool do not trigger legacy adoption (#5242)", async () => {
	const genericParent = join(root, "generic-parent");
	const a1 = join(genericParent, "a1");
	mkdirSync(join(genericParent, "repos", "x", ".git"), { recursive: true });
	mkdirSync(join(genericParent, "worktrees", "y"), { recursive: true });
	mkdirSync(join(genericParent, "workflows", "runs", "run-1"), { recursive: true });
	mkdirSync(join(genericParent, "workflows", "pool", "logs"), { recursive: true });
	writeFileSync(join(genericParent, "storage.sqlite"), "");
	writeFileSync(join(genericParent, "workflows", "runs", "run-1", "out.txt"), "artifact\n");
	writeFileSync(join(genericParent, "workflows", "pool", "logs", "worker.log"), "log\n");
	mkdirSync(a1, { recursive: true });

	assert.equal(storageHomeDir(a1), a1);
	assert.equal(existsSync(join(genericParent, "workflows", ".adopted-by")), false);
	const status = await collectStorageStatus({ cwd: project, agentDir: a1, probe: false });
	assert.deepEqual(status.notes, []);

	const sharedParent = join(root, "empty-shared-parent");
	const s1 = join(sharedParent, "s1");
	const s2 = join(sharedParent, "s2");
	mkdirSync(s1, { recursive: true });
	mkdirSync(s2, { recursive: true });
	writeFileSync(join(sharedParent, "storage.sqlite"), "");
	assert.deepEqual(selectSessionStorage(project, { agentDir: s1, settings: { storage: {} } }), {
		kind: "sqlite",
		path: join(sharedParent, "storage.sqlite"),
	});
	assert.deepEqual(selectSessionStorage(project, { agentDir: s2, settings: { storage: {} } }), {
		kind: "sqlite",
		path: join(s2, "storage.sqlite"),
	});
});

test("adoption honors effective merged settings from SDK in-memory settings and trusted project settings without pre-settling during process validation (#5242)", async () => {
	const sdkParent = join(root, "sdk-settings-parent");
	const a1 = join(sdkParent, "a1");
	const a2 = join(sdkParent, "a2");
	mkdirSync(a1, { recursive: true });
	mkdirSync(a2, { recursive: true });
	const seededSdkStore = await resolveSessionStore(project, {
		agentDir: a1,
		sessionStore: { kind: "sqlite", path: join(sdkParent, "team.sqlite") },
	});
	try {
		await seededSdkStore.create(
			{
				id: "66666666-6666-4666-8666-666666666666",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await seededSdkStore.close();
	}
	resetStorageHomeCacheForTests();

	const inMemorySettings = { storage: { path: "team.sqlite" } };
	const a1Store = await resolveSessionStore(project, { agentDir: a1, settings: inMemorySettings });
	const a2Store = await resolveSessionStore(project, { agentDir: a2, settings: inMemorySettings });
	try {
		assert.equal(
			(await a1Store.readHeader("66666666-6666-4666-8666-666666666666"))?.id,
			"66666666-6666-4666-8666-666666666666",
		);
		assert.equal(await a2Store.readHeader("66666666-6666-4666-8666-666666666666"), undefined);
	} finally {
		await a1Store.close();
		await a2Store.close();
	}

	const projParent = join(root, "proj-settings-parent");
	const b1 = join(projParent, "b1");
	const b2 = join(projParent, "b2");
	const trustedProject = join(root, "trusted-project");
	mkdirSync(b1, { recursive: true });
	mkdirSync(b2, { recursive: true });
	mkdirSync(join(trustedProject, ".atomic"), { recursive: true });
	writeFileSync(
		join(trustedProject, ".atomic", "settings.json"),
		JSON.stringify({ storage: { path: "team.sqlite" } }),
	);
	new ProjectTrustStore(b1).set(trustedProject, true);
	new ProjectTrustStore(b2).set(trustedProject, true);

	const seededProjStore = await resolveSessionStore(trustedProject, {
		agentDir: b1,
		sessionStore: { kind: "sqlite", path: join(projParent, "team.sqlite") },
	});
	try {
		await seededProjStore.create(
			{
				id: "77777777-7777-4777-8777-777777777777",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: trustedProject,
			},
			[],
		);
	} finally {
		await seededProjStore.close();
	}
	resetStorageHomeCacheForTests();

	const b1Status = await collectStorageStatus({ cwd: trustedProject, agentDir: b1, probe: true });
	assert.equal(
		b1Status.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(projParent, "team.sqlite")}`,
	);
	assert.ok(b1Status.notes.some((note) => /Adopted existing storage/.test(note)));

	const b1Store = await resolveSessionStore(trustedProject, { agentDir: b1 });
	const b2Store = await resolveSessionStore(trustedProject, { agentDir: b2 });
	try {
		assert.equal(
			(await b1Store.readHeader("77777777-7777-4777-8777-777777777777"))?.id,
			"77777777-7777-4777-8777-777777777777",
		);
		assert.equal(await b2Store.readHeader("77777777-7777-4777-8777-777777777777"), undefined);
	} finally {
		await b1Store.close();
		await b2Store.close();
	}

	const valParent = join(root, "val-parent");
	const d1 = join(valParent, "d1");
	mkdirSync(d1, { recursive: true });
	const seededValStore = await resolveSessionStore(project, {
		agentDir: d1,
		sessionStore: { kind: "sqlite", path: join(valParent, "team.sqlite") },
	});
	try {
		await seededValStore.create(
			{
				id: "88888888-8888-4888-8888-888888888888",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await seededValStore.close();
	}
	resetStorageHomeCacheForTests();

	vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ path: join(root, "abs-env.sqlite") }));
	validateProcessStorage(d1);
	vi.stubEnv("ATOMIC_STORAGE", "");
	const d1Store = await resolveSessionStore(project, { agentDir: d1, settings: inMemorySettings });
	try {
		assert.equal(
			(await d1Store.readHeader("88888888-8888-4888-8888-888888888888"))?.id,
			"88888888-8888-4888-8888-888888888888",
		);
	} finally {
		await d1Store.close();
	}
});

test("an adopted parent store stays adopted when the agent directory is reopened through a symlink alias (#5242, #5219)", async () => {
	const parent = join(root, "alias-parent");
	const a1 = join(parent, "a1");
	const a2 = join(parent, "a2");
	const legacyHostId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
	mkdirSync(join(parent, "workflows", "pool"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	writeFileSync(join(parent, "workflows", "pool", "host-id"), `${legacyHostId}\n`);
	mkdirSync(a1, { recursive: true });
	mkdirSync(a2, { recursive: true });

	const initialStore = await resolveSessionStore(project, { agentDir: a1, settings: {} });
	try {
		await initialStore.create(
			{
				id: "99999999-9999-4999-8999-999999999999",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await initialStore.close();
	}
	writeFileSync(join(parent, "workflows", "pool", "host-id.adopted-by"), `${a1}\n`);

	const link = join(root, "parent-link");
	symlinkSync(parent, link, "junction");
	resetStorageHomeCacheForTests();

	const aliasedA1 = join(link, "a1");
	const aliasedA2 = join(link, "a2");
	assert.equal(isSameFile(storageHomeDir(aliasedA1), parent), true);
	const aliasedStore = await resolveSessionStore(project, { agentDir: aliasedA1, settings: {} });
	try {
		assert.equal(
			(await aliasedStore.readHeader("99999999-9999-4999-8999-999999999999"))?.id,
			"99999999-9999-4999-8999-999999999999",
		);
	} finally {
		await aliasedStore.close();
	}
	assert.equal(storageHomeDir(aliasedA2), aliasedA2);
	assert.equal(sameDirectory(aliasedA1, a1), true);
	assert.equal(readClaimFile(join(parent, "workflows", ".adopted-by")), a1);
});

test("user workflow resource discovery keeps nested journal, pool, and runs files in default ~/.atomic/agent, ~/.pi/agent, and adopted directories while excluding them in co-located custom directories (#5242)", async () => {
	const home = join(root, "res-home");
	const defaultAgent = join(home, ".atomic", "agent");
	const piAgent = join(home, ".pi", "agent");
	const defaultTop = join(defaultAgent, "workflows", "top.ts");
	const defaultNested = join(defaultAgent, "workflows", "runs", "nested.ts");
	const piNested = join(piAgent, "workflows", "runs", "pi-nested.ts");
	mkdirSync(join(defaultAgent, "workflows", "runs"), { recursive: true });
	mkdirSync(join(piAgent, "workflows", "runs"), { recursive: true });
	writeFileSync(defaultTop, "export default {};\n");
	writeFileSync(defaultNested, "export default {};\n");
	writeFileSync(piNested, "export default {};\n");

	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	delete process.env.ATOMIC_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;

	const defaultManager = new DefaultPackageManager({
		cwd: project,
		agentDir: defaultAgent,
		settingsManager: SettingsManager.inMemory(),
	});
	const defaultResolved = await defaultManager.resolve();
	const defaultPaths = defaultResolved.workflows.map((entry) => entry.path);
	assert.equal(defaultPaths.includes(defaultTop), true);
	assert.equal(defaultPaths.includes(defaultNested), true);
	assert.equal(defaultPaths.includes(piNested), true);

	const adoptedParent = join(root, "adopted-res-parent");
	const adoptedAgent = join(adoptedParent, "a1");
	const adoptedNested = join(adoptedAgent, "workflows", "runs", "adopted-nested.ts");
	mkdirSync(join(adoptedParent, "workflows"), { recursive: true });
	writeFileSync(join(adoptedParent, "workflows", ".adopted-by"), `${adoptedAgent}\n`);
	mkdirSync(join(adoptedAgent, "workflows", "runs"), { recursive: true });
	writeFileSync(adoptedNested, "export default {};\n");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", adoptedAgent);
	const adoptedManager = new DefaultPackageManager({
		cwd: project,
		agentDir: adoptedAgent,
		settingsManager: SettingsManager.inMemory(),
	});
	const adoptedResolved = await adoptedManager.resolve();
	assert.equal(
		adoptedResolved.workflows.some((entry) => entry.path === adoptedNested),
		true,
	);
});

test("cross-domain process environment variables and settings-blind lookups do not pre-settle adoption before settings-aware resolution (#5242)", async () => {
	const parent1 = join(root, "cross-domain-1");
	const a1 = join(parent1, "a1");
	const a2 = join(parent1, "a2");
	mkdirSync(a1, { recursive: true });
	mkdirSync(a2, { recursive: true });
	const seeded1 = await resolveSessionStore(project, {
		agentDir: a1,
		sessionStore: { kind: "sqlite", path: join(parent1, "team.sqlite") },
	});
	try {
		await seeded1.create(
			{
				id: "aaaaaaaa-1111-4111-8111-111111111111",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await seeded1.close();
	}
	resetStorageHomeCacheForTests();

	vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", "{}");
	const sessionSettings = { sessions: { storage: { path: "team.sqlite" } } };
	const store1 = await resolveSessionStore(project, { agentDir: a1, settings: sessionSettings });
	const store2 = await resolveSessionStore(project, { agentDir: a2, settings: sessionSettings });
	try {
		assert.equal(
			(await store1.readHeader("aaaaaaaa-1111-4111-8111-111111111111"))?.id,
			"aaaaaaaa-1111-4111-8111-111111111111",
		);
		assert.equal(await store2.readHeader("aaaaaaaa-1111-4111-8111-111111111111"), undefined);
	} finally {
		await store1.close();
		await store2.close();
	}
	vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", "");

	const parent3 = join(root, "provisional-parent");
	const c1 = join(parent3, "c1");
	mkdirSync(c1, { recursive: true });
	writeFileSync(join(parent3, "late-settings.sqlite"), "");
	for (let lookup = 0; lookup < 3; lookup++) assert.equal(storageHomeDir(c1), c1);
	assert.deepEqual(
		selectSessionStorage(project, { agentDir: c1, settings: { storage: { path: "late-settings.sqlite" } } }),
		{
			kind: "sqlite",
			path: join(parent3, "late-settings.sqlite"),
		},
	);
	assert.equal(storageHomeDir(c1), parent3);
});

test.skipIf(process.platform === "win32")(
	"an agent directory ending with a literal backslash on POSIX stays distinct from its sibling without the backslash (#5242)",
	async () => {
		const parent = join(root, "posix-backslash");
		const plain = join(parent, "profile");
		const withBackslash = `${plain}\\`;
		mkdirSync(plain, { recursive: true });
		mkdirSync(withBackslash, { recursive: true });

		assert.equal(storageHomeDir(plain), plain);
		assert.equal(storageHomeDir(withBackslash), withBackslash);
		assert.equal(defaultSessionDatabasePath(plain), join(plain, "workflows", "journal.sqlite"));
		assert.equal(defaultSessionDatabasePath(withBackslash), join(withBackslash, "workflows", "journal.sqlite"));

		const plainStore = await resolveSessionStore(project, { agentDir: plain, settings: {} });
		const backslashStore = await resolveSessionStore(project, { agentDir: withBackslash, settings: {} });
		try {
			await plainStore.create(
				{
					id: "bbbbbbbb-2222-4222-8222-222222222222",
					version: 4,
					createdAt: "2026-11-16T00:00:00.000Z",
					cwd: project,
				},
				[],
			);
			assert.equal(
				(await plainStore.readHeader("bbbbbbbb-2222-4222-8222-222222222222"))?.id,
				"bbbbbbbb-2222-4222-8222-222222222222",
			);
			assert.equal(await backslashStore.readHeader("bbbbbbbb-2222-4222-8222-222222222222"), undefined);
		} finally {
			await plainStore.close();
			await backslashStore.close();
		}
	},
);

test("relative storage target classification matches untrimmed resolvePath rules for leading-whitespace paths (#5242)", async () => {
	const parent = join(root, "untrimmed-target");
	const a1 = join(parent, "a1");
	const a2 = join(parent, "a2");
	mkdirSync(a1, { recursive: true });
	mkdirSync(a2, { recursive: true });

	const seeded = await resolveSessionStore(project, {
		agentDir: a1,
		sessionStore: { kind: "sqlite", path: join(parent, " ~") },
	});
	try {
		await seeded.create(
			{
				id: "cccccccc-3333-4333-8333-333333333333",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await seeded.close();
	}
	resetStorageHomeCacheForTests();

	const settings = { storage: { path: " ~" } };
	const store1 = await resolveSessionStore(project, { agentDir: a1, settings });
	const store2 = await resolveSessionStore(project, { agentDir: a2, settings });
	try {
		assert.equal(
			(await store1.readHeader("cccccccc-3333-4333-8333-333333333333"))?.id,
			"cccccccc-3333-4333-8333-333333333333",
		);
		assert.equal(await store2.readHeader("cccccccc-3333-4333-8333-333333333333"), undefined);
	} finally {
		await store1.close();
		await store2.close();
	}
});

test("process-level session selection without explicit options.settings loads merged project settings before settling adoption (#5242)", async () => {
	const parent2 = join(root, "lazy-merged-2");
	const b1 = join(parent2, "b1");
	const trustedProj2 = join(root, "lazy-proj-2");
	mkdirSync(b1, { recursive: true });
	mkdirSync(join(trustedProj2, ".atomic"), { recursive: true });
	writeFileSync(
		join(trustedProj2, ".atomic", "settings.json"),
		JSON.stringify({ sessions: { storage: { path: "team.sqlite" } } }),
	);
	new ProjectTrustStore(b1).set(trustedProj2, true);
	writeFileSync(join(parent2, "team.sqlite"), "");
	resetStorageHomeCacheForTests();

	const originalCwd = process.cwd();
	try {
		process.chdir(trustedProj2);
		vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", "{}");
		assert.deepEqual(selectSessionStorage(trustedProj2, { agentDir: b1 }), {
			kind: "sqlite",
			path: join(parent2, "team.sqlite"),
		});
	} finally {
		vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", "");
		process.chdir(originalCwd);
	}
});

test("user workflow resource discovery preserves nested runs, pool, and journal files before an unclaimed parent store is adopted (#5242)", async () => {
	const parent1 = join(root, "preadopt-resource-1");
	const a1 = join(parent1, "a1");
	const topFlow = join(a1, "workflows", "top.ts");
	const nestedFlow = join(a1, "workflows", "runs", "my-user-flow.ts");
	mkdirSync(join(parent1, "workflows"), { recursive: true });
	writeFileSync(join(parent1, "workflows", "journal.sqlite"), "");
	mkdirSync(join(a1, "workflows", "runs"), { recursive: true });
	writeFileSync(topFlow, "export default {};\n");
	writeFileSync(nestedFlow, "export default {};\n");

	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", a1);
	const manager1 = new DefaultPackageManager({
		cwd: project,
		agentDir: a1,
		settingsManager: SettingsManager.create(project, a1),
	});
	const resolved1 = await manager1.resolve();
	const paths1 = resolved1.workflows.map((entry) => entry.path);
	assert.equal(paths1.includes(topFlow), true);
	assert.equal(paths1.includes(nestedFlow), true);
	assert.equal(existsSync(join(parent1, "workflows", ".adopted-by")), false);

	const parent2 = join(root, "preadopt-resource-2");
	const b1 = join(parent2, "b1");
	const projFlow = join(b1, "workflows", "runs", "proj-user-flow.ts");
	const trustedProj = join(root, "preadopt-proj");
	mkdirSync(join(b1, "workflows", "runs"), { recursive: true });
	writeFileSync(projFlow, "export default {};\n");
	writeFileSync(join(parent2, "team.sqlite"), "");
	mkdirSync(join(trustedProj, ".atomic"), { recursive: true });
	writeFileSync(join(trustedProj, ".atomic", "settings.json"), JSON.stringify({ storage: { path: "team.sqlite" } }));
	new ProjectTrustStore(b1).set(trustedProj, true);

	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", b1);
	const manager2 = new DefaultPackageManager({
		cwd: trustedProj,
		agentDir: b1,
		settingsManager: SettingsManager.create(trustedProj, b1),
	});
	const resolved2 = await manager2.resolve();
	assert.equal(
		resolved2.workflows.some((entry) => entry.path === projFlow),
		true,
	);
	assert.equal(existsSync(join(parent2, "workflows", ".adopted-by")), false);
});

test("a nonexistent or empty sibling directory never claims an existing parent store ahead of a sibling with prior agent-directory state, while a sole nonexistent directory still adopts (#5242)", async () => {
	const parent = join(root, "prior-use-parent");
	const oldProfile = join(parent, "old");
	const emptyNew = join(parent, "empty-new");
	const nonexistentNew = join(parent, "brand-new");
	mkdirSync(oldProfile, { recursive: true });
	mkdirSync(emptyNew, { recursive: true });

	const seeded = await resolveSessionStore(project, {
		agentDir: oldProfile,
		sessionStore: { kind: "sqlite", path: join(parent, "workflows", "journal.sqlite") },
	});
	try {
		await seeded.create(
			{
				id: "dddddddd-4444-4444-8444-444444444444",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await seeded.close();
	}
	writeFileSync(join(oldProfile, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
	rmSync(join(parent, "workflows", ".adopted-by"), { force: true });
	resetStorageHomeCacheForTests();

	const brandNewStatus = await collectStorageStatus({ cwd: project, agentDir: nonexistentNew, probe: false });
	assert.equal(
		brandNewStatus.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(nonexistentNew, "workflows", "journal.sqlite")}`,
	);
	assert.deepEqual(brandNewStatus.notes, []);
	assert.equal(existsSync(nonexistentNew), false);
	assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);

	const emptyNewStatus = await collectStorageStatus({ cwd: project, agentDir: emptyNew, probe: false });
	assert.equal(
		emptyNewStatus.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(emptyNew, "workflows", "journal.sqlite")}`,
	);
	assert.deepEqual(emptyNewStatus.notes, []);
	assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);

	const oldStatus = await collectStorageStatus({ cwd: project, agentDir: oldProfile, probe: true });
	assert.equal(
		oldStatus.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(parent, "workflows", "journal.sqlite")}`,
	);
	assert.ok(oldStatus.notes.some((note) => /Adopted existing storage/.test(note)));

	const oldStore = await resolveSessionStore(project, { agentDir: oldProfile, settings: {} });
	try {
		assert.equal(
			(await oldStore.readHeader("dddddddd-4444-4444-8444-444444444444"))?.id,
			"dddddddd-4444-4444-8444-444444444444",
		);
	} finally {
		await oldStore.close();
	}

	const soleParent = join(root, "sole-nonexistent-parent");
	const soleNonexistent = join(soleParent, "nonexistent");
	mkdirSync(join(soleParent, "workflows"), { recursive: true });
	writeFileSync(join(soleParent, "workflows", "journal.sqlite"), "");
	assert.equal(storageHomeDir(soleNonexistent), soleParent);
});

test("a hidden dot-prefixed sibling profile with prior Atomic state keeps parent adoption ahead of a nonexistent or empty sibling (#5242)", async () => {
	const parent = join(root, "hidden-sibling-parent");
	const hiddenOld = join(parent, ".profile-old");
	const newSibling = join(parent, "new");
	mkdirSync(hiddenOld, { recursive: true });

	const seeded = await resolveSessionStore(project, {
		agentDir: join(root, "seed-helper-a"),
		sessionStore: { kind: "sqlite", path: join(parent, "workflows", "journal.sqlite") },
	});
	try {
		await seeded.create(
			{
				id: "eeeeeeee-5555-4555-8555-555555555555",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await seeded.close();
	}
	writeFileSync(join(hiddenOld, "settings.json"), JSON.stringify({ defaultModel: "claude-sonnet-4-5" }));
	resetStorageHomeCacheForTests();

	const newStatus = await collectStorageStatus({ cwd: project, agentDir: newSibling, probe: false });
	assert.deepEqual(newStatus.notes, []);
	assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);

	const oldStore = await resolveSessionStore(project, { agentDir: hiddenOld, settings: {} });
	const newStore = await resolveSessionStore(project, { agentDir: newSibling, settings: {} });
	try {
		assert.equal(
			(await oldStore.readHeader("eeeeeeee-5555-4555-8555-555555555555"))?.id,
			"eeeeeeee-5555-4555-8555-555555555555",
		);
		assert.equal(await newStore.readHeader("eeeeeeee-5555-4555-8555-555555555555"), undefined);
	} finally {
		await oldStore.close();
		await newStore.close();
	}
	assert.equal(readClaimFile(join(parent, "workflows", ".adopted-by")), hiddenOld);
});

test("an agent directory named workflows adopts its existing parent store in place while a sibling isolates (#5242)", async () => {
	const parent = join(root, "workflows-named-parent");
	const workflowsAgent = join(parent, "workflows");
	const sibling = join(parent, "a2");
	mkdirSync(workflowsAgent, { recursive: true });
	mkdirSync(sibling, { recursive: true });
	writeFileSync(join(workflowsAgent, "settings.json"), JSON.stringify({ sessions: { storage: {} } }));

	const seeded = await resolveSessionStore(project, {
		agentDir: join(root, "seed-helper-b"),
		sessionStore: { kind: "sqlite", path: join(workflowsAgent, "journal.sqlite") },
	});
	try {
		await seeded.create(
			{
				id: "ffffffff-6666-4666-8666-666666666666",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await seeded.close();
	}
	resetStorageHomeCacheForTests();

	const store = await resolveSessionStore(project, { agentDir: workflowsAgent, settings: {} });
	const siblingStore = await resolveSessionStore(project, { agentDir: sibling, settings: {} });
	try {
		assert.equal(
			(await store.readHeader("ffffffff-6666-4666-8666-666666666666"))?.id,
			"ffffffff-6666-4666-8666-666666666666",
		);
		assert.equal(await siblingStore.readHeader("ffffffff-6666-4666-8666-666666666666"), undefined);
	} finally {
		await store.close();
		await siblingStore.close();
	}
	assert.equal(existsSync(join(workflowsAgent, "workflows", "journal.sqlite")), false);
});

test("unrelated sibling settings do not hide an extension-only agent directory's legacy sessions (#5242)", async () => {
	const home = join(root, "unrelated-sibling-home");
	const agentDir = join(home, "myagent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: [] } }));
	mkdirSync(join(home, ".editor"), { recursive: true });
	writeFileSync(join(home, ".editor", "settings.json"), JSON.stringify({ theme: "dark" }));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);

	const sessionId = "45454545-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const seeded = await resolveSessionStore(project, {
		agentDir: join(root, "unrelated-sibling-seed"),
		sessionStore: { kind: "sqlite", path: join(home, "workflows", "journal.sqlite") },
	});
	try {
		await seeded.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: project }, []);
	} finally {
		await seeded.close();
	}
	resetStorageHomeCacheForTests();

	const store = await resolveSessionStore(project, { agentDir, settings: {} });
	try {
		assert.equal((await store.readHeader(sessionId))?.id, sessionId);
	} finally {
		await store.close();
	}
	assert.equal(readClaimFile(join(home, "workflows", ".adopted-by")), agentDir);
	const status = await collectStorageStatus({ cwd: project, agentDir, probe: false });
	assert.ok(status.notes.some((note) => /Adopted existing storage/.test(note)));
	assert.deepEqual((await collectStorageStatus({ cwd: project, agentDir, probe: false })).notes, []);
});

test("a populated relative session store remains visible after a parent target appears and the process restarts (#5242)", async () => {
	const selections: readonly ({ readonly dir: string } | { readonly path: string })[] = [
		{ dir: "sessions" },
		{ path: "history.sqlite" },
	];
	for (const selection of selections) {
		const parent = join(root, "dir" in selection ? "populated-jsonl" : "populated-sqlite");
		const agentDir = join(parent, "a1");
		const sibling = join(parent, "a2");
		const settings = { sessions: { storage: selection } };
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		const ownId = "23232323-8888-4888-8888-888888888888";
		const foreignId = "34343434-9999-4999-8999-999999999999";
		const header = { version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: project } as const;
		const own = await resolveSessionStore(project, { agentDir, settings });
		try {
			await own.create({ ...header, id: ownId }, []);
		} finally {
			await own.close();
		}
		assert.equal(storageHomeDir(agentDir, settings), agentDir);

		const legacy = await resolveSessionStore(project, {
			agentDir: join(root, "relative-store-seed"),
			sessionStore:
				"dir" in selection
					? { kind: "jsonl", dir: join(parent, selection.dir) }
					: { kind: "sqlite", path: join(parent, selection.path) },
		});
		try {
			await legacy.create({ ...header, id: foreignId }, []);
		} finally {
			await legacy.close();
		}
		resetStorageHomeCacheForTests();

		const reopened = await resolveSessionStore(project, { agentDir, settings });
		try {
			assert.equal((await reopened.readHeader(ownId))?.id, ownId);
			assert.equal(await reopened.readHeader(foreignId), undefined);
		} finally {
			await reopened.close();
		}
		assert.equal(storageHomeDir(agentDir, settings), agentDir);
		assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);
		assert.equal(storageHomeDir(sibling, settings), parent);
	}
});

test("an empty <agentDir>/sessions directory does not block adoption of a populated <parent>/sessions store (#5242)", async () => {
	const parent = join(root, "jsonl-sessions-parent");
	const a1 = join(parent, "a1");
	const a2 = join(parent, "a2");
	mkdirSync(join(a1, "sessions"), { recursive: true });
	mkdirSync(join(a2, "sessions"), { recursive: true });

	const seededSessions = await resolveSessionStore(project, {
		agentDir: join(root, "seed-helper-c"),
		sessionStore: { kind: "jsonl", dir: join(parent, "sessions") },
	});
	try {
		await seededSessions.create(
			{
				id: "12121212-7777-4777-8777-777777777777",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await seededSessions.close();
	}

	const settings = { sessions: { storage: { dir: "sessions" } } };
	writeFileSync(join(a1, "settings.json"), JSON.stringify(settings));
	writeFileSync(join(a2, "settings.json"), JSON.stringify(settings));
	resetStorageHomeCacheForTests();

	const a1Sessions = await resolveSessionStore(project, { agentDir: a1 });
	const a2Sessions = await resolveSessionStore(project, { agentDir: a2 });
	try {
		assert.equal(
			(await a1Sessions.readHeader("12121212-7777-4777-8777-777777777777"))?.id,
			"12121212-7777-4777-8777-777777777777",
		);
		assert.equal(await a2Sessions.readHeader("12121212-7777-4777-8777-777777777777"), undefined);
	} finally {
		await a1Sessions.close();
		await a2Sessions.close();
	}

	const ownCatalogParent = join(root, "own-catalog-parent");
	const ownCatalogAgent = join(ownCatalogParent, "a1");
	mkdirSync(join(ownCatalogParent, "sessions"), { recursive: true });
	mkdirSync(join(ownCatalogAgent, "sessions"), { recursive: true });
	mkdirSync(join(ownCatalogAgent, "workflows", "journal"), { recursive: true });
	writeFileSync(join(ownCatalogAgent, "workflows", "journal", "catalog.sqlite"), "");
	writeFileSync(join(ownCatalogAgent, "settings.json"), JSON.stringify(settings));
	assert.equal(storageHomeDir(ownCatalogAgent, settings), ownCatalogAgent);
});

test("the Intercom broker's storage-only lookup never claims a parent store that the agent directory's own settings keep local (#5242)", async () => {
	const parent = join(root, "broker-partial-settings");
	const agent = join(parent, "a1");
	const legacySibling = join(parent, "a2");
	const settings = { storage: {}, sessions: { storage: { dir: "sessions" } } };
	mkdirSync(join(agent, "sessions"), { recursive: true });
	writeFileSync(join(agent, "sessions", "own-history.jsonl"), "{}\n");
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	mkdirSync(legacySibling, { recursive: true });
	writeFileSync(join(legacySibling, "settings.json"), JSON.stringify({ defaultModel: "example" }));

	assert.equal(storageHomeDir(agent, settings), agent);

	resetStorageHomeCacheForTests();
	const broker = await resolveBrokerStateSource({}, agent);
	assert.equal(broker.status, "shared");
	if (broker.status === "shared") {
		const db = await broker.source.openDatabase();
		try {
			assert.equal(db.descriptor.location, join(agent, "storage.sqlite"));
		} finally {
			await db.close();
		}
	}
	assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);

	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(agent, settings), agent);
	assert.equal(storageHomeDir(legacySibling), parent);
});

test("sibling directories keep their existing parent-relative session directories after one of them adopts the parent (#5242)", () => {
	const parent = join(root, "relative-sibling-targets");
	const selections = new Map<string, { sessions: { storage: { dir: string } } }>();
	for (const name of ["a1", "a2"]) {
		const agent = join(parent, name);
		const settings = { sessions: { storage: { dir: `${name}/sessions` } } };
		selections.set(name, settings);
		mkdirSync(join(agent, "sessions"), { recursive: true });
		writeFileSync(join(agent, "sessions", `${name}-history.jsonl`), "{}\n");
		writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
	}

	for (const name of ["a1", "a2"]) {
		const agent = join(parent, name);
		const selection = selectSessionStorage(project, { agentDir: agent, settings: selections.get(name) });
		assert.deepEqual(selection, { kind: "jsonl", dir: join(agent, "sessions") });
		assert.deepEqual(readdirSync(join(agent, "sessions")), [`${name}-history.jsonl`]);
	}
});

test("a worker host-id claim naming a deleted agent directory does not keep the parent store from the remaining directory (#5242, #5219)", () => {
	const parent = join(root, "stale-host-id-owner");
	const remaining = join(parent, "current");
	mkdirSync(join(parent, "workflows", "pool"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	writeFileSync(join(parent, "workflows", "pool", "host-id"), "legacy-host\n");
	writeFileSync(join(parent, "workflows", "pool", "host-id.adopted-by"), `${join(parent, "deleted")}\n`);
	mkdirSync(remaining, { recursive: true });
	writeFileSync(join(remaining, "settings.json"), JSON.stringify({ defaultModel: "example" }));

	assert.equal(storageHomeDir(remaining), parent);
	assert.equal(defaultSessionDatabasePath(remaining), join(parent, "workflows", "journal.sqlite"));
});

test.skipIf(process.platform === "win32")(
	"an agent directory whose name ends in a carriage return adopts the parent store it claimed, and a sibling without it does not (#5242)",
	() => {
		const parent = join(root, "carriage-return-name");
		const claimant = join(parent, "a\r");
		const sibling = join(parent, "a");
		mkdirSync(join(parent, "workflows"), { recursive: true });
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
		mkdirSync(claimant, { recursive: true });
		writeFileSync(join(claimant, "settings.json"), JSON.stringify({ defaultModel: "example" }));

		assert.equal(storageHomeDir(claimant, {}), parent);
		assert.equal(readClaimFile(join(parent, "workflows", ".adopted-by")), claimant);

		mkdirSync(sibling, { recursive: true });
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(sibling), sibling);
		assert.equal(storageHomeDir(claimant), parent);
	},
);

test("an explicit absolute sessions selection does not adopt the parent through an inactive relative target in the agent directory's settings file (#5242)", () => {
	const parent = join(root, "explicit-absolute-override");
	const agent = join(parent, "a1");
	const elsewhere = join(root, "elsewhere", "sessions");
	mkdirSync(join(parent, "sessions"), { recursive: true });
	writeFileSync(join(parent, "sessions", "legacy.jsonl"), "{}\n");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ sessions: { storage: { dir: "sessions" } } }));
	const override = { sessions: { storage: { dir: elsewhere } } };

	assert.equal(storageHomeDir(agent, override), agent);
	assert.deepEqual(selectSessionStorage(project, { agentDir: agent, settings: override }), {
		kind: "jsonl",
		dir: elsewhere,
	});
	assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);
});

test("siblings that both select a relative sessions directory never share the legacy parent directory after one adopts it (#5242)", () => {
	const parent = join(root, "shared-relative-sessions");
	const settings = { sessions: { storage: { dir: "sessions" } } };
	mkdirSync(join(parent, "sessions"), { recursive: true });
	writeFileSync(join(parent, "sessions", "legacy.jsonl"), "{}\n");
	for (const name of ["a1", "a2"]) {
		mkdirSync(join(parent, name), { recursive: true });
		writeFileSync(join(parent, name, "settings.json"), JSON.stringify(settings));
	}

	assert.deepEqual(selectSessionStorage(project, { agentDir: join(parent, "a1"), settings }), {
		kind: "jsonl",
		dir: join(parent, "sessions"),
	});
	assert.deepEqual(selectSessionStorage(project, { agentDir: join(parent, "a2"), settings }), {
		kind: "jsonl",
		dir: join(parent, "a2", "sessions"),
	});
});

test("a sibling holding Atomic credentials or model configuration still outranks an empty directory for the legacy parent store (#5242)", () => {
	for (const [file, contents] of [
		["auth.json", JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } })],
		["models.json", JSON.stringify({ providers: { custom: { baseUrl: "https://example.com" } } })],
	] as const) {
		const parent = join(root, `atomic-configuration-${file}`);
		const fresh = join(parent, "fresh");
		const used = join(parent, "work");
		mkdirSync(join(parent, "workflows"), { recursive: true });
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
		mkdirSync(fresh, { recursive: true });
		mkdirSync(used, { recursive: true });
		writeFileSync(join(used, file), contents);

		assert.equal(storageHomeDir(fresh), fresh);
		assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(used), parent);
	}
});

test("an agent directory beside non-Atomic tool directories adopts the legacy store it used (#5242)", () => {
	for (const [label, directory, file, contents] of [
		["claude", ".claude", "settings.json", JSON.stringify({ permissions: {} })],
		["gemini", ".gemini", "settings.json", JSON.stringify({ theme: "x" })],
		["codex", ".codex", "auth.json", JSON.stringify({ OPENAI_API_KEY: null })],
		["generic-models", ".other", "models.json", JSON.stringify({ models: [] })],
		["vscode", ".vscode", "settings.json", JSON.stringify({ "editor.tabSize": 2 })],
	] as const) {
		const parent = join(root, `non-atomic-${label}`);
		const agent = join(parent, "myagent");
		mkdirSync(join(parent, "workflows"), { recursive: true });
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
		mkdirSync(join(agent, "extensions"), { recursive: true });
		mkdirSync(join(parent, directory), { recursive: true });
		writeFileSync(join(parent, directory, file), contents);
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(agent), parent, label);
	}
});

test("a second process of one agent directory keeps its storage home when a parent store appears after the first process settled (#5242)", () => {
	const parent = join(root, "same-dir-processes");
	const agent = join(parent, "a1");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultModel: "example" }));
	const settings = {};

	const firstProcess = storageHomeDir(agent, settings);
	assert.equal(firstProcess, agent);

	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	resetStorageHomeCacheForTests();
	const secondProcess = storageHomeDir(agent, settings);
	assert.equal(secondProcess, firstProcess);

	mkdirSync(join(firstProcess, "workflows"), { recursive: true });
	writeFileSync(join(firstProcess, "workflows", "journal.sqlite"), "");
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(agent, settings), firstProcess);
	assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);
});

test("sibling directories keep separate external parent-relative session stores (#5242)", () => {
	const parent = join(root, "external-relative-sibling-targets");
	for (const name of ["a1", "a2"]) {
		const agent = join(parent, name);
		const settings = { sessions: { storage: { dir: `${name}-sessions` } } };
		mkdirSync(agent, { recursive: true });
		mkdirSync(join(parent, `${name}-sessions`), { recursive: true });
		writeFileSync(join(parent, `${name}-sessions`, "history.jsonl"), "{}\n");
		writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
	}
	for (const name of ["a1", "a2"]) {
		const agent = join(parent, name);
		const settings = { sessions: { storage: { dir: `${name}-sessions` } } };
		assert.deepEqual(selectSessionStorage(project, { agentDir: agent, settings }), {
			kind: "jsonl",
			dir: join(parent, `${name}-sessions`),
		});
	}
});

test("storage status does not create a nonexistent agent directory named workflows while preserving a legacy relative target (#5242)", async () => {
	const parent = join(root, "missing-workflows-agent");
	const agent = join(parent, "workflows");
	mkdirSync(parent, { recursive: true });
	writeFileSync(join(parent, "history.sqlite"), "");
	vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify({ path: "history.sqlite" }));
	const status = await collectStorageStatus({ cwd: project, agentDir: agent, probe: false });
	assert.equal(
		status.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(parent, "history.sqlite")}`,
	);
	assert.equal(existsSync(agent), false);
	assert.deepEqual(status.notes, []);
	mkdirSync(agent);
	resetStorageHomeCacheForTests();
	const adopted = await collectStorageStatus({ cwd: project, agentDir: agent, probe: false });
	assert.equal(adopted.notes.filter((note) => /Adopted existing storage/.test(note)).length, 1);
	assert.deepEqual((await collectStorageStatus({ cwd: project, agentDir: agent, probe: false })).notes, []);
});

test("a settings-blind parent lookup remains provisional until merged SDK settings select an existing local target (#5242)", () => {
	const parent = join(root, "provisional-parent-lookup");
	const agent = join(parent, "a1");
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	mkdirSync(join(agent, "local-sessions"), { recursive: true });
	writeFileSync(join(agent, "local-sessions", "history.jsonl"), "{}\n");
	assert.equal(storageHomeDir(agent), parent);
	assert.equal(storageHomeDir(agent, { sessions: { storage: { dir: "local-sessions" } } }), agent);
	assert.equal(existsSync(join(parent, "workflows", ".adopted-by")), false);
	assert.equal(storageHomeDir(join(parent, "a2"), {}), parent);
});

test("a legacy worker host claim cannot reserve the parent for a directory whose merged settings durably selected its own home (#5242, #5219)", () => {
	const parent = join(root, "settled-local-host-owner");
	const first = join(parent, "a1");
	const second = join(parent, "a2");
	mkdirSync(join(first, "local-sessions"), { recursive: true });
	writeFileSync(join(first, "local-sessions", "history.jsonl"), "{}\n");
	mkdirSync(second, { recursive: true });
	mkdirSync(join(parent, "workflows", "pool"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	writeFileSync(join(parent, "workflows", "pool", "host-id"), "legacy-host\n");
	writeFileSync(join(parent, "workflows", "pool", "host-id.adopted-by"), `${first}\n`);
	assert.equal(storageHomeDir(first, { sessions: { storage: { dir: "local-sessions" } } }), first);
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(second, {}), parent);
});

test("adopting through a parent directory alias does not hide history when that alias is removed (#5242)", () => {
	const parent = join(root, "physical-adoption-parent");
	const agent = join(parent, "a1");
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	const alias = join(root, "temporary-parent-alias");
	symlinkSync(parent, alias, "junction");
	const initial = selectSessionStorage(project, { agentDir: join(alias, "a1"), settings: {} });
	assert.ok("kind" in initial && initial.kind === "sqlite");
	rmSync(alias, { recursive: true, force: true });
	resetStorageHomeCacheForTests();
	assert.deepEqual(selectSessionStorage(project, { agentDir: agent, settings: {} }), {
		kind: "sqlite",
		path: join(parent, "workflows", "journal.sqlite"),
	});
});

test("a custom profile directly under the default home cannot claim the default agent's configured relative history before it starts (#5242)", () => {
	const home = join(root, "default-target-owner");
	const atomic = join(home, ".atomic");
	const original = join(atomic, "agent");
	const custom = join(atomic, "custom");
	const settings = { sessions: { storage: { dir: "sessions" } } };
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	mkdirSync(original, { recursive: true });
	mkdirSync(custom, { recursive: true });
	mkdirSync(join(atomic, "sessions"), { recursive: true });
	writeFileSync(join(atomic, "sessions", "history.jsonl"), "{}\n");
	writeFileSync(join(original, "settings.json"), JSON.stringify(settings));
	assert.deepEqual(selectSessionStorage(project, { agentDir: custom, settings }), {
		kind: "jsonl",
		dir: join(custom, "sessions"),
	});
	assert.deepEqual(selectSessionStorage(project, { agentDir: original, settings }), {
		kind: "jsonl",
		dir: join(atomic, "sessions"),
	});
});

test("renaming an adopting agent directory in its parent keeps its session history (#5242)", () => {
	const parent = join(root, "renamed-owner");
	const original = join(parent, "a1");
	const renamed = join(parent, "main-profile");
	mkdirSync(original, { recursive: true });
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(defaultSessionDatabasePath(original, {}), join(parent, "workflows", "journal.sqlite"));
	renameSync(original, renamed);
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(renamed, {}), join(parent, "workflows", "journal.sqlite"));
	mkdirSync(original);
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(original, {}), join(original, "workflows", "journal.sqlite"));
	assert.equal(defaultSessionDatabasePath(renamed, {}), join(parent, "workflows", "journal.sqlite"));
});

test("a never-created SDK agent directory beside ordinary source directories retains its parent history (#5242)", () => {
	const parent = join(root, "stateless-sdk");
	const agent = join(parent, "sdk-agent");
	for (const name of ["src", "docs", "workflows"]) mkdirSync(join(parent, name), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(defaultSessionDatabasePath(agent, {}), join(parent, "workflows", "journal.sqlite"));
	assert.equal(existsSync(agent), false);
});

test("changing HOME cannot make a custom profile share the original default agent's store (#5242)", () => {
	const originalHome = join(root, "original-home");
	const atomic = join(originalHome, ".atomic");
	const original = join(atomic, "agent");
	const custom = join(atomic, "work");
	mkdirSync(original, { recursive: true });
	mkdirSync(custom, { recursive: true });
	writeFileSync(join(custom, "settings.json"), JSON.stringify({ defaultModel: "example" }));
	vi.stubEnv("HOME", originalHome);
	vi.stubEnv("USERPROFILE", originalHome);
	const originalStore = defaultSessionDatabasePath(original, {});
	mkdirSync(join(atomic, "workflows"));
	writeFileSync(originalStore, "");
	assert.equal(storageHomeDir(custom, {}), custom);
	resetStorageHomeCacheForTests();
	vi.stubEnv("HOME", join(root, "different-home"));
	vi.stubEnv("USERPROFILE", join(root, "different-home"));
	assert.equal(defaultSessionDatabasePath(custom, {}), join(custom, "workflows", "journal.sqlite"));
	assert.equal(defaultSessionDatabasePath(original, {}), originalStore);
});

test("a settings-aware home decision replaces provisional cached spellings of the same directory (#5242)", () => {
	const parent = join(root, "provisional-spellings");
	const agent = join(parent, "a1");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(parent, "history.sqlite"), "");
	const alias = `${agent}/`;
	assert.equal(storageHomeDir(agent), agent);
	assert.equal(storageHomeDir(alias), agent);
	assert.equal(storageHomeDir(alias, { sessions: { storage: { path: "history.sqlite" } } }), parent);
	assert.equal(storageHomeDir(agent), parent);
});

test("an agent with an open-session registry keeps priority over an empty new sibling (#5242)", () => {
	const parent = join(root, "open-session-priority");
	const original = join(parent, "original");
	const fresh = join(parent, "fresh");
	mkdirSync(join(original, "open-sessions"), { recursive: true });
	mkdirSync(fresh, { recursive: true });
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(storageHomeDir(fresh, {}), fresh);
	assert.equal(storageHomeDir(original, {}), parent);
});

test("explicit relative JSONL settings retain the parent target beside pre-SQLite agent sessions (#5242)", () => {
	const parent = join(root, "pre-sqlite-relative-sessions");
	const agent = join(parent, "a1");
	for (const base of [agent, parent]) {
		mkdirSync(join(base, "sessions"), { recursive: true });
		writeFileSync(join(base, "sessions", "history.jsonl"), "{}\n");
	}
	const settings = { sessions: { storage: { dir: "sessions" } } };
	assert.deepEqual(selectSessionStorage(project, { agentDir: agent, settings }), {
		kind: "jsonl",
		dir: join(parent, "sessions"),
	});
});

test("a default-agent alias keeps its unclaimed legacy parent history when the canonical default home has no store (#5242)", () => {
	const home = join(root, "default-agent-legacy-alias");
	const canonical = join(home, ".atomic", "agent");
	const alias = join(home, "link-agent");
	mkdirSync(canonical, { recursive: true });
	mkdirSync(join(home, "workflows"));
	writeFileSync(join(home, "workflows", "journal.sqlite"), "");
	symlinkSync(canonical, alias, "junction");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	assert.equal(defaultSessionDatabasePath(alias, {}), join(home, "workflows", "journal.sqlite"));
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(canonical, {}), join(home, "workflows", "journal.sqlite"));
});

test("agent resources retain legacy-store eligibility beside a credentials-only sibling (#5242)", () => {
	for (const resource of ["extensions", "skills", "prompts", "themes", "agents"]) {
		const parent = join(root, `resource-priority-${resource}`);
		const original = join(parent, "agent");
		const sibling = join(parent, "other");
		mkdirSync(join(original, resource), { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }));
		mkdirSync(join(parent, "workflows"));
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
		assert.equal(storageHomeDir(original, {}), parent, resource);
		assert.equal(storageHomeDir(sibling, {}), sibling, resource);
	}
});

test("relative parent traversal cannot expose an adopted default store to custom siblings (#5242)", () => {
	const home = join(root, "adopted-default-traversal");
	const canonical = join(home, ".atomic", "agent");
	const alias = join(home, "link-agent");
	mkdirSync(canonical, { recursive: true });
	mkdirSync(join(home, "workflows"));
	writeFileSync(join(home, "workflows", "journal.sqlite"), "");
	symlinkSync(canonical, alias, "junction");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	assert.equal(defaultSessionDatabasePath(alias, {}), join(home, "workflows", "journal.sqlite"));
	for (const name of ["a1", "a2"]) {
		const agent = join(home, ".atomic", name);
		mkdirSync(agent);
		assert.throws(
			() =>
				selectSessionStorage(project, {
					agentDir: agent,
					settings: { sessions: { storage: { path: "../workflows/journal.sqlite" } } },
				}),
			/owned by another agent directory/,
		);
	}
});
