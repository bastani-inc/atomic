import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	defaultJournalStoreDirectory,
	defaultSessionDatabasePath,
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
import { resolveRunJournal, selectRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { isShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { workflowJournalPath } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	ENV_WORKFLOW_ARTIFACT_DIR,
	workflowArtifactRunsRoot,
} from "../../packages/workflows/src/shared/workflow-artifacts.js";
import { poolHostId, poolStateDirectory } from "../../packages/workflows/src/workers/pool-journal.js";
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

test("two sibling agent directories under one parent keep separate session, journal, shard, pool, artifact, and Intercom stores (#5242)", async () => {
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
	assert.equal(defaultJournalStoreDirectory(first), join(first, "workflows", "journal"));
	assert.equal(defaultJournalStoreDirectory(second), join(second, "workflows", "journal"));
	assert.equal(poolStateDirectory(first), join(first, "workflows", "pool"));
	assert.equal(poolStateDirectory(second), join(second, "workflows", "pool"));

	vi.stubEnv(ENV_WORKFLOW_ARTIFACT_DIR, "");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", first);
	assert.equal(workflowArtifactRunsRoot(), join(first, "workflows", "runs"));
	assert.equal(workflowJournalPath(), join(first, "workflows", "journal.sqlite"));
	assert.ok(buildSessionMemoryGuideline(["read"], project)?.includes(join(first, "workflows", "journal.sqlite")));

	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", second);
	assert.equal(workflowArtifactRunsRoot(), join(second, "workflows", "runs"));
	assert.equal(workflowJournalPath(), join(second, "workflows", "journal.sqlite"));
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

	const firstJournal = await resolveRunJournal({ agentDir: first, settings: {} });
	const secondJournal = await resolveRunJournal({ agentDir: second, settings: {} });
	try {
		assert.ok(isShardedRunJournal(firstJournal));
		assert.ok(isShardedRunJournal(secondJournal));
		assert.equal(firstJournal.directory, join(first, "workflows", "journal"));
		assert.equal(secondJournal.directory, join(second, "workflows", "journal"));
		assert.equal(
			await firstJournal.createRun({
				runId: "run-in-a1",
				name: "wf",
				cwd: project,
				createdAt: 1,
				status: "running",
			}),
			"created",
		);
		assert.equal((await firstJournal.listRuns()).length, 1);
		assert.equal((await secondJournal.listRuns()).length, 0);
	} finally {
		await firstJournal.close();
		await secondJournal.close();
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
		firstStatus.domains.find((entry) => entry.domain === "journal")?.selection,
		`journal store ${join(first, "workflows", "journal")}`,
	);
	assert.equal(
		secondStatus.domains.find((entry) => entry.domain === "sessions")?.selection,
		`SQLite ${join(second, "workflows", "journal.sqlite")}`,
	);
	assert.equal(
		secondStatus.domains.find((entry) => entry.domain === "journal")?.selection,
		`journal store ${join(second, "workflows", "journal")}`,
	);
	assert.equal(existsSync(join(root, "workflows")), false);
});

test("default ~/.atomic/agent keeps its store at ~/.atomic/workflows (#5242)", async () => {
	const home = join(root, "home");
	const atomicHome = join(home, ".atomic");
	const defaultAgent = join(atomicHome, "agent");
	mkdirSync(defaultAgent, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv(ENV_WORKFLOW_ARTIFACT_DIR, "");

	for (const configured of [undefined, defaultAgent]) {
		if (configured === undefined) {
			delete process.env.ATOMIC_CODING_AGENT_DIR;
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", configured);
		}
		assert.deepEqual(selectSessionStorage(project, { agentDir: defaultAgent, settings: {} }), {
			kind: "sqlite",
			path: join(atomicHome, "workflows", "journal.sqlite"),
		});
		assert.deepEqual(selectRunJournal({ agentDir: defaultAgent, settings: {} }), {
			kind: "sharded",
			dir: join(atomicHome, "workflows", "journal"),
		});
		assert.equal(defaultJournalStoreDirectory(defaultAgent), join(atomicHome, "workflows", "journal"));
		assert.equal(poolStateDirectory(defaultAgent), join(atomicHome, "workflows", "pool"));
		assert.equal(workflowArtifactRunsRoot(), join(atomicHome, "workflows", "runs"));
		assert.equal(workflowJournalPath(), join(atomicHome, "workflows", "journal.sqlite"));
		assert.equal(secretFilePath("agent/storage-token.1", defaultAgent), join(atomicHome, "agent/storage-token.1"));
		const status = await collectStorageStatus({ cwd: project, agentDir: defaultAgent, probe: false });
		assert.equal(
			status.domains.find((entry) => entry.domain === "sessions")?.selection,
			`SQLite ${join(atomicHome, "workflows", "journal.sqlite")}`,
		);
		assert.equal(
			status.domains.find((entry) => entry.domain === "journal")?.selection,
			`journal store ${join(atomicHome, "workflows", "journal")}`,
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
	assert.equal(defaultJournalStoreDirectory(customSibling), join(customSibling, "workflows", "journal"));
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
	assert.equal(
		firstStatus.domains.find((entry) => entry.domain === "journal")?.selection,
		`journal store ${join(root, "workflows", "journal")}`,
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
	assert.equal(
		secondStatus.domains.find((entry) => entry.domain === "journal")?.selection,
		`journal store ${join(second, "workflows", "journal")}`,
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
	assert.equal(defaultJournalStoreDirectory(first), join(root, "workflows", "journal"));
	assert.equal(defaultJournalStoreDirectory(second), join(second, "workflows", "journal"));
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
	assert.equal(defaultJournalStoreDirectory(agentAlias), join(atomicHomeDir, "workflows", "journal"));
});

test("storage home stays stable across an in-flight asynchronous session-store open when a parent store appears mid-open (#5242)", async () => {
	const parent = join(root, "mid-open");
	const child = join(parent, "a1");
	mkdirSync(child, { recursive: true });

	const initialSessionPath = defaultSessionDatabasePath(child);
	assert.equal(initialSessionPath, join(child, "workflows", "journal.sqlite"));
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");

	assert.equal(defaultSessionDatabasePath(child), initialSessionPath);
	assert.deepEqual(selectRunJournal({ agentDir: child, settings: {} }), {
		kind: "sharded",
		dir: join(child, "workflows", "journal"),
	});

	const store = await resolveSessionStore(project, { agentDir: child, settings: {} });
	try {
		await store.create(
			{
				id: "44444444-4444-4444-8444-444444444444",
				version: 4,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: project,
			},
			[],
		);
	} finally {
		await store.close();
	}

	const reopened = await resolveSessionStore(project, { agentDir: child, settings: {} });
	try {
		assert.equal(
			(await reopened.readHeader("44444444-4444-4444-8444-444444444444"))?.id,
			"44444444-4444-4444-8444-444444444444",
		);
	} finally {
		await reopened.close();
	}
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

	assert.equal(storageHomeDir(tmpFirst), customTmp);
	assert.equal(storageHomeDir(tmpSecond), tmpSecond);

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

	assert.equal(storageHomeDir(nestedFirst), defaultAgent);
	assert.equal(storageHomeDir(nestedSecond), nestedSecond);
});

test.skipIf(process.platform === "win32")(
	"an agent directory whose name ends with a space adopts an existing parent store and keeps its legacy host id (#5242, #5219)",
	() => {
		const parent = join(root, "whitespace");
		const legacyHostId = "0b9f3c3e-6a8e-4f3c-9a4e-2f6d8c1b7a55";
		mkdirSync(join(parent, "workflows", "pool"), { recursive: true });
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
		writeFileSync(join(parent, "workflows", "pool", "host-id"), `${legacyHostId}\n`);
		const trailingSpaceDir = join(parent, "profile ");
		const siblingDir = join(parent, "sibling");
		mkdirSync(trailingSpaceDir, { recursive: true });
		mkdirSync(siblingDir, { recursive: true });

		assert.equal(storageHomeDir(trailingSpaceDir), parent);
		assert.equal(poolHostId(trailingSpaceDir), legacyHostId);
		assert.equal(storageHomeDir(siblingDir), siblingDir);
		assert.notEqual(poolHostId(siblingDir), legacyHostId);
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

	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", legacyA1);
	assert.equal(atomicHome(), legacyParent);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", legacyA2);
	assert.equal(atomicHome(), legacyA2);
});

test("legacy worker host-id adoption and storage-home adoption select the same single winner (#5242, #5219)", () => {
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

	assert.notEqual(poolHostId(a2WithLocalStore), legacy1);
	assert.equal(storageHomeDir(a2WithLocalStore), a2WithLocalStore);
	assert.equal(poolHostId(a1), legacy1);
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
	assert.equal(poolHostId(b2ClaimedHostId), legacy2);
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

	const journalParent = join(root, "journal-settings-parent");
	const c1 = join(journalParent, "c1");
	const c2 = join(journalParent, "c2");
	mkdirSync(c1, { recursive: true });
	mkdirSync(c2, { recursive: true });
	writeFileSync(join(journalParent, "j.sqlite"), "");
	assert.deepEqual(selectRunJournal({ agentDir: c1, settings: { workflows: { journal: { path: "j.sqlite" } } } }), {
		kind: "sqlite",
		path: join(journalParent, "j.sqlite"),
	});
	assert.deepEqual(selectRunJournal({ agentDir: c2, settings: { workflows: { journal: { path: "j.sqlite" } } } }), {
		kind: "sqlite",
		path: join(c2, "j.sqlite"),
	});

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

test("an adopted parent store and legacy pool host id stay adopted when the agent directory is reopened through a symlink alias (#5242, #5219)", async () => {
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
	assert.equal(poolHostId(aliasedA1), legacyHostId);
});
