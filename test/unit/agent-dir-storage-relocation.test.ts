import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { resolveSessionStore, selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import {
	coLocatesWorkflowStore,
	defaultSessionDatabasePath,
	fileIdentity,
	resetStorageHomeCacheForTests,
	storagePathBaseDir,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-relocation-");
	resetStorageHomeCacheForTests();
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
		"ATOMIC_PROFILE",
	])
		vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function useHome(home: string): void {
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", "");
	vi.stubEnv("PI_CODING_AGENT_DIR", "");
	resetStorageHomeCacheForTests();
}

test.each(["move", "share"])(
	"the default storage home follows the current HOME after a %s of its agent directory (#5242)",
	async (operation) => {
		const original = join(root, "original-home");
		const current = join(root, "current-home");
		const originalAgent = join(original, ".atomic", "agent");
		mkdirSync(originalAgent, { recursive: true });
		useHome(original);
		assert.equal(defaultSessionDatabasePath(undefined, {}), join(original, ".atomic", "workflows", "journal.sqlite"));
		if (operation === "move") {
			renameSync(original, current);
		} else {
			mkdirSync(join(current, ".atomic"), { recursive: true });
			symlinkSync(originalAgent, join(current, ".atomic", "agent"), "junction");
		}
		useHome(current);
		const expected = join(current, ".atomic", "workflows", "journal.sqlite");
		assert.equal(defaultSessionDatabasePath(undefined, {}), expected);
		const status = await collectStorageStatus({
			cwd: root,
			agentDir: join(current, ".atomic", "agent"),
			probe: false,
		});
		assert.equal(status.domains.find((domain) => domain.domain === "sessions")?.selection, `SQLite ${expected}`);
		assert.equal(existsSync(join(original, ".atomic", "workflows")), false);
	},
);

test("a default profile copied to a custom location cannot select an unrelated parent store (#5242)", () => {
	const home = join(root, "copied-default-home");
	const original = join(home, ".atomic", "agent");
	const parent = join(root, "custom-profiles");
	const custom = join(parent, "custom");
	const sibling = join(parent, "sibling");
	mkdirSync(original, { recursive: true });
	useHome(home);
	assert.equal(defaultSessionDatabasePath(original, {}), join(home, ".atomic", "workflows", "journal.sqlite"));
	cpSync(original, custom, { recursive: true });
	mkdirSync(sibling);
	mkdirSync(join(parent, "workflows"));
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "unrelated history");
	resetStorageHomeCacheForTests();
	assert.equal(coLocatesWorkflowStore(custom, {}), true);
	assert.equal(defaultSessionDatabasePath(custom, {}), join(custom, "workflows", "journal.sqlite"));
	assert.equal(defaultSessionDatabasePath(sibling, {}), join(parent, "workflows", "journal.sqlite"));
});

test("default relative selections follow the current home when the agent directory is shared (#5242)", () => {
	const original = join(root, "relative-original-home");
	const current = join(root, "relative-current-home");
	const originalAgent = join(original, ".atomic", "agent");
	const currentAgent = join(current, ".atomic", "agent");
	mkdirSync(originalAgent, { recursive: true });
	const settings = { sessions: { storage: { path: "history.sqlite" } } };
	useHome(original);
	assert.equal(storagePathBaseDir("history.sqlite", originalAgent, settings), join(original, ".atomic"));
	mkdirSync(join(current, ".atomic"), { recursive: true });
	symlinkSync(originalAgent, currentAgent, "junction");
	useHome(current);
	assert.equal(storagePathBaseDir("history.sqlite", currentAgent, settings), join(current, ".atomic"));
});

test.each(["host", "other"])(
	"settling a shared default agent under another HOME cannot transfer the host's relative history to a custom profile using the %s HOME (#5242)",
	async (activeHome) => {
		const host = join(root, "host-home");
		const other = join(root, "other-home");
		const atomic = join(host, ".atomic");
		const agent = join(atomic, "agent");
		const alias = join(other, ".atomic", "agent");
		const custom = join(atomic, "custom");
		const settings = { sessions: { storage: { path: "team.sqlite" } } };
		mkdirSync(agent, { recursive: true });
		mkdirSync(custom);
		writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
		const sessionId = "33333333-3333-4333-8333-333333333333";
		const seeded = await resolveSessionStore(root, {
			agentDir: agent,
			sessionStore: { kind: "sqlite", path: join(atomic, "team.sqlite") },
		});
		await seeded.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
		await seeded.close();
		mkdirSync(join(other, ".atomic"), { recursive: true });
		symlinkSync(agent, alias, "junction");
		useHome(other);
		assert.equal(defaultSessionDatabasePath(alias, settings), join(other, ".atomic", "workflows", "journal.sqlite"));
		useHome(activeHome === "host" ? host : other);
		assert.deepEqual(selectSessionStorage(root, { agentDir: custom, settings }), {
			kind: "sqlite",
			path: join(custom, "team.sqlite"),
		});
		useHome(host);
		assert.deepEqual(selectSessionStorage(root, { agentDir: agent, settings }), {
			kind: "sqlite",
			path: join(atomic, "team.sqlite"),
		});
		const restored = await resolveSessionStore(root, { agentDir: agent, settings });
		try {
			assert.equal((await restored.readHeader(sessionId))?.id, sessionId);
		} finally {
			await restored.close();
		}
	},
);

test.each(["owner-first", "sibling-first"])(
	"moving an adopted parent keeps history and sibling isolation with %s resolution (#5242)",
	(order) => {
		const original = join(root, "original-parent");
		const moved = join(root, "moved-parent");
		const agent = join(original, "agent");
		mkdirSync(agent, { recursive: true });
		mkdirSync(join(original, "workflows"));
		writeFileSync(join(original, "workflows", "journal.sqlite"), "");
		assert.equal(defaultSessionDatabasePath(agent, {}), join(original, "workflows", "journal.sqlite"));
		renameSync(original, moved);
		const current = join(moved, "agent");
		const sibling = join(moved, "sibling");
		mkdirSync(sibling);
		resetStorageHomeCacheForTests();
		for (const selected of order === "owner-first" ? [current, sibling] : [sibling, current]) {
			assert.equal(
				defaultSessionDatabasePath(selected, {}),
				join(selected === current ? moved : sibling, "workflows", "journal.sqlite"),
			);
		}
		assert.equal(existsSync(original), false);
	},
);

test.each(["rename", "copy"])(
	"moving an alias parent by %s retains its adopted default and relative stores (#5242)",
	(operation) => {
		const physical = join(root, "physical-agent");
		const original = join(root, "alias-parent");
		const moved = join(root, "moved-alias-parent");
		mkdirSync(physical);
		mkdirSync(join(original, "workflows"), { recursive: true });
		writeFileSync(join(original, "workflows", "journal.sqlite"), "");
		writeFileSync(join(original, "history.sqlite"), "");
		symlinkSync(physical, join(original, "agent"), "junction");
		const settings = { sessions: { storage: { path: "history.sqlite" } } };
		assert.equal(
			defaultSessionDatabasePath(join(original, "agent"), settings),
			join(original, "workflows", "journal.sqlite"),
		);
		assert.equal(storagePathBaseDir("history.sqlite", join(original, "agent"), settings), original);
		if (operation === "rename") renameSync(original, moved);
		else {
			cpSync(original, moved, { recursive: true, filter: (source) => source !== join(original, "agent") });
			symlinkSync(physical, join(moved, "agent"), "junction");
			rmSync(original, { recursive: true });
		}
		resetStorageHomeCacheForTests();
		assert.equal(
			defaultSessionDatabasePath(join(moved, "agent"), settings),
			join(moved, "workflows", "journal.sqlite"),
		);
		assert.equal(storagePathBaseDir("history.sqlite", join(moved, "agent"), settings), moved);
		const sibling = join(moved, "sibling");
		mkdirSync(sibling);
		assert.equal(defaultSessionDatabasePath(sibling, {}), join(sibling, "workflows", "journal.sqlite"));
		assert.equal(existsSync(original), false);
	},
);

test("a copied-and-moved parent retains ownership after filesystem identities change (#5242)", () => {
	const original = join(root, "copied-parent");
	const moved = join(root, "moved-copied-parent");
	const agent = join(original, "agent");
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(original, "workflows"));
	writeFileSync(join(original, "workflows", "journal.sqlite"), "");
	assert.equal(defaultSessionDatabasePath(agent, {}), join(original, "workflows", "journal.sqlite"));
	cpSync(original, moved, { recursive: true });
	rmSync(original, { recursive: true });
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(join(moved, "agent"), {}), join(moved, "workflows", "journal.sqlite"));
	const sibling = join(moved, "sibling");
	mkdirSync(sibling);
	assert.equal(defaultSessionDatabasePath(sibling, {}), join(sibling, "workflows", "journal.sqlite"));
});

test("a copied-and-moved parent keeps adopted history beside pre-existing in-directory JSONL sessions (#5242)", async () => {
	const original = join(root, "relative-jsonl-parent");
	const moved = join(root, "moved-relative-jsonl-parent");
	const agent = join(original, "a1");
	const settings = { sessions: { storage: { dir: "sessions" } } };
	mkdirSync(join(agent, "sessions"), { recursive: true });
	writeFileSync(join(agent, "sessions", "old-default.jsonl"), "{}\n");
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
	const sessionId = "55555555-5555-4555-8555-555555555555";
	const sessions = await resolveSessionStore(root, {
		agentDir: agent,
		sessionStore: { kind: "jsonl", dir: join(original, "sessions") },
	});
	await sessions.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
	await sessions.close();
	const journal = await resolveRunJournal({
		agentDir: agent,
		journal: { path: join(original, "workflows", "journal.sqlite") },
	});
	await journal.createRun({ runId: "relative-jsonl-run", name: "wf", cwd: root, createdAt: 1, status: "completed" });
	await journal.close();
	assert.equal(defaultSessionDatabasePath(agent, settings), join(original, "workflows", "journal.sqlite"));
	cpSync(original, moved, { recursive: true });
	rmSync(original, { recursive: true });
	resetStorageHomeCacheForTests();
	const current = join(moved, "a1");
	assert.equal(defaultSessionDatabasePath(current, settings), join(moved, "workflows", "journal.sqlite"));
	assert.deepEqual(selectSessionStorage(root, { agentDir: current, settings }), {
		kind: "jsonl",
		dir: join(moved, "sessions"),
	});
	const restoredSessions = await resolveSessionStore(root, { agentDir: current, settings });
	try {
		assert.equal((await restoredSessions.readHeader(sessionId))?.id, sessionId);
	} finally {
		await restoredSessions.close();
	}
	const restoredJournal = await resolveRunJournal({ agentDir: current, settings });
	try {
		assert.equal((await restoredJournal.getRun("relative-jsonl-run"))?.runId, "relative-jsonl-run");
	} finally {
		await restoredJournal.close();
	}
});

test("a copied-and-moved parent with outward relative targets still retains its default history (#5242)", () => {
	const original = join(root, "outward-parent");
	const moved = join(root, "moved-outward-parent");
	const agent = join(original, "agent");
	const settings = { sessions: { storage: { path: "../external.sqlite" } } };
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(original, "workflows"));
	for (const path of [
		join(original, "workflows", "journal.sqlite"),
		join(original, "external.sqlite"),
		join(root, "external.sqlite"),
	]) {
		writeFileSync(path, "");
	}
	assert.equal(defaultSessionDatabasePath(agent, settings), join(original, "workflows", "journal.sqlite"));
	cpSync(original, moved, { recursive: true });
	rmSync(original, { recursive: true });
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(join(moved, "agent"), settings), join(moved, "workflows", "journal.sqlite"));
});

test.each(["copy-before-move", "copy-after-move"])(
	"an adopter keeps session and workflow history with %s when its parent's filesystem identities change (#5242)",
	async (operation) => {
		const original = join(root, "cloned-parent");
		const moved = join(root, "moved-cloned-parent");
		const agent = join(original, "a1");
		mkdirSync(agent, { recursive: true });
		const sessionId = "66666666-6666-4666-8666-666666666666";
		const sessions = await resolveSessionStore(root, {
			agentDir: agent,
			sessionStore: { kind: "sqlite", path: join(original, "workflows", "journal.sqlite") },
		});
		await sessions.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
		await sessions.close();
		const journal = await resolveRunJournal({
			agentDir: agent,
			journal: { path: join(original, "workflows", "journal.sqlite") },
		});
		await journal.createRun({ runId: "cloned-parent-run", name: "wf", cwd: root, createdAt: 1, status: "completed" });
		await journal.close();
		assert.equal(defaultSessionDatabasePath(agent, {}), join(original, "workflows", "journal.sqlite"));
		if (operation === "copy-before-move") cpSync(agent, join(original, "a1-backup"), { recursive: true });
		cpSync(original, moved, { recursive: true });
		rmSync(original, { recursive: true });
		const current = join(moved, "a1");
		const clone = join(moved, "a1-backup");
		if (operation === "copy-after-move") cpSync(current, clone, { recursive: true });
		resetStorageHomeCacheForTests();
		assert.equal(defaultSessionDatabasePath(clone, {}), join(clone, "workflows", "journal.sqlite"));
		assert.equal(defaultSessionDatabasePath(current, {}), join(moved, "workflows", "journal.sqlite"));
		const restoredSessions = await resolveSessionStore(root, { agentDir: current, settings: {} });
		try {
			assert.equal((await restoredSessions.readHeader(sessionId))?.id, sessionId);
		} finally {
			await restoredSessions.close();
		}
		const restoredJournal = await resolveRunJournal({ agentDir: current, settings: {} });
		try {
			assert.equal((await restoredJournal.getRun("cloned-parent-run"))?.runId, "cloned-parent-run");
		} finally {
			await restoredJournal.close();
		}
	},
);

test.each(["copy-before-rename", "copy-after-rename", "copy-to-old-name"])(
	"a renamed adopter keeps its parent history with %s (#5242)",
	async (operation) => {
		const parent = join(root, "cloned-adopter");
		const original = join(parent, "a1");
		const renamed = join(parent, "main");
		const clone = operation === "copy-to-old-name" ? original : join(parent, "clone");
		const sibling = join(parent, "a3");
		mkdirSync(original, { recursive: true });
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const seeded = await resolveSessionStore(root, {
			agentDir: original,
			sessionStore: { kind: "sqlite", path: join(parent, "workflows", "journal.sqlite") },
		});
		await seeded.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
		await seeded.close();
		assert.equal(defaultSessionDatabasePath(original, {}), join(parent, "workflows", "journal.sqlite"));
		if (operation === "copy-before-rename") cpSync(original, clone, { recursive: true });
		renameSync(original, renamed);
		if (operation !== "copy-before-rename") cpSync(renamed, clone, { recursive: true });
		mkdirSync(sibling);
		resetStorageHomeCacheForTests();
		assert.equal(defaultSessionDatabasePath(renamed, {}), join(parent, "workflows", "journal.sqlite"));
		assert.equal(defaultSessionDatabasePath(clone, {}), join(clone, "workflows", "journal.sqlite"));
		assert.equal(defaultSessionDatabasePath(sibling, {}), join(sibling, "workflows", "journal.sqlite"));
		const restored = await resolveSessionStore(root, { agentDir: renamed, settings: {} });
		try {
			assert.equal((await restored.readHeader(sessionId))?.id, sessionId);
		} finally {
			await restored.close();
		}
	},
);

test("a clone with its own history keeps that store after the adopting original is deleted (#5242)", async () => {
	const parent = join(root, "deleted-adopter");
	const original = join(parent, "a1");
	const clone = join(parent, "a2");
	mkdirSync(original, { recursive: true });
	mkdirSync(join(parent, "workflows"));
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(defaultSessionDatabasePath(original, {}), join(parent, "workflows", "journal.sqlite"));
	cpSync(original, clone, { recursive: true });
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(clone, {}), join(clone, "workflows", "journal.sqlite"));
	const sessionId = "22222222-2222-4222-8222-222222222222";
	const own = await resolveSessionStore(root, { agentDir: clone, settings: {} });
	await own.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
	await own.close();
	rmSync(original, { recursive: true });
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(clone, {}), join(clone, "workflows", "journal.sqlite"));
	const restored = await resolveSessionStore(root, { agentDir: clone, settings: {} });
	try {
		assert.equal((await restored.readHeader(sessionId))?.id, sessionId);
	} finally {
		await restored.close();
	}
});

test("a clone's SDK-selected local database prevents copied identities from taking over the parent (#5242)", async () => {
	const parent = join(root, "sdk-cloned-adopter");
	const original = join(parent, "a1");
	const clone = join(parent, "a2");
	const settings = { sessions: { storage: { path: "history.sqlite" } } };
	mkdirSync(original, { recursive: true });
	writeFileSync(join(parent, "history.sqlite"), "");
	assert.deepEqual(selectSessionStorage(root, { agentDir: original, settings }), {
		kind: "sqlite",
		path: join(parent, "history.sqlite"),
	});
	cpSync(original, clone, { recursive: true });
	resetStorageHomeCacheForTests();
	const sessionId = "44444444-4444-4444-8444-444444444444";
	const own = await resolveSessionStore(root, { agentDir: clone, settings });
	await own.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
	await own.close();
	rmSync(original, { recursive: true });
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(clone, settings), join(clone, "workflows", "journal.sqlite"));
	assert.deepEqual(selectSessionStorage(root, { agentDir: clone, settings }), {
		kind: "sqlite",
		path: join(clone, "history.sqlite"),
	});
	const restored = await resolveSessionStore(root, { agentDir: clone, settings });
	try {
		assert.equal((await restored.readHeader(sessionId))?.id, sessionId);
	} finally {
		await restored.close();
	}
});

test("a clone's new settings-file database keeps its own history after the adopter is removed (#5242)", async () => {
	const parent = join(root, "configured-cloned-adopter");
	const original = join(parent, "a1");
	const clone = join(parent, "a2");
	const settings = { sessions: { storage: { path: "clone.sqlite" } } };
	mkdirSync(original, { recursive: true });
	mkdirSync(join(parent, "workflows"));
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(defaultSessionDatabasePath(original, {}), join(parent, "workflows", "journal.sqlite"));
	cpSync(original, clone, { recursive: true });
	writeFileSync(join(clone, "settings.json"), JSON.stringify(settings));
	resetStorageHomeCacheForTests();
	const sessionId = "77777777-7777-4777-8777-777777777777";
	const own = await resolveSessionStore(root, { agentDir: clone });
	await own.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
	await own.close();
	rmSync(original, { recursive: true });
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(clone, settings), join(clone, "workflows", "journal.sqlite"));
	assert.deepEqual(selectSessionStorage(root, { agentDir: clone }), {
		kind: "sqlite",
		path: join(clone, "clone.sqlite"),
	});
	const restored = await resolveSessionStore(root, { agentDir: clone });
	try {
		assert.equal((await restored.readHeader(sessionId))?.id, sessionId);
	} finally {
		await restored.close();
	}
});

test("ambiguous copied adopters without their original leave every sibling isolated (#5242)", () => {
	const parent = join(root, "ambiguous-copies");
	const original = join(parent, "a1");
	const first = join(parent, "first-copy");
	const second = join(parent, "second-copy");
	const sibling = join(parent, "fresh");
	mkdirSync(original, { recursive: true });
	mkdirSync(join(parent, "workflows"));
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(defaultSessionDatabasePath(original, {}), join(parent, "workflows", "journal.sqlite"));
	cpSync(original, first, { recursive: true });
	cpSync(original, second, { recursive: true });
	rmSync(original, { recursive: true });
	mkdirSync(sibling);
	resetStorageHomeCacheForTests();
	for (const agent of [first, second, sibling]) {
		assert.equal(defaultSessionDatabasePath(agent, {}), join(agent, "workflows", "journal.sqlite"));
	}
});

test("absolute adoption records recover the moved parent and renamed owner without reading a foreign old path (#5242)", () => {
	const original = join(root, "legacy-parent");
	const moved = join(root, "moved-legacy-parent");
	const agent = join(original, "original-agent");
	const renamed = join(moved, "renamed-agent");
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(original, "workflows"));
	writeFileSync(join(original, "workflows", "journal.sqlite"), "");
	const decision = join(agent, ".atomic-storage-home");
	writeFileSync(decision, JSON.stringify({ home: original, parentOwner: agent }));
	writeFileSync(
		join(original, ".atomic-storage-parent-owner"),
		JSON.stringify({ path: agent, identity: fileIdentity(decision), homeIdentity: true }),
	);
	writeFileSync(join(original, "workflows", ".adopted-by"), `${agent}\n`);
	renameSync(original, moved);
	renameSync(join(moved, "original-agent"), renamed);
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(moved, "sibling"));
	assert.equal(
		defaultSessionDatabasePath(join(moved, "sibling"), {}),
		join(moved, "sibling", "workflows", "journal.sqlite"),
	);
	assert.equal(defaultSessionDatabasePath(renamed, {}), join(moved, "workflows", "journal.sqlite"));
	assert.equal(existsSync(join(original, "workflows")), false);
});
