import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const gate = vi.hoisted(() => ({
	agentDir: undefined as string | undefined,
	reached: undefined as (() => void) | undefined,
	release: undefined as Promise<void> | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const { existsSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
	const mkdir = (async (...args: Parameters<typeof actual.mkdir>) => {
		const path = String(args[0]);
		if (path === gate.agentDir && existsSync(join(path, ".atomic-storage-home"))) {
			gate.agentDir = undefined;
			gate.reached?.();
			await gate.release;
		}
		return actual.mkdir(...args);
	}) as typeof actual.mkdir;
	return { ...actual, mkdir, default: { ...actual, mkdir } };
});

vi.resetModules();
const { resolveSessionStore } = await import("../../packages/coding-agent/src/core/session-storage.js");
const { defaultSessionDatabasePath, resetStorageHomeCacheForTests } = await import(
	"../../packages/coding-agent/src/core/storage/file-identity.js"
);

let root: string;
let project: string;

beforeEach(() => {
	resetStorageHomeCacheForTests();
	for (const key of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
		"ATOMIC_PROFILE",
	])
		vi.stubEnv(key, "");
	root = makeTempDirectory("agent-dir-storage-mid-open-");
	project = join(root, "project");
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	gate.agentDir = undefined;
	vi.unstubAllEnvs();
	resetStorageHomeCacheForTests();
	removeTempDirectory(root);
});

test("storage home stays stable across an in-flight asynchronous session-store open when a parent store appears mid-open (#5242)", async () => {
	const parent = join(root, "mid-open");
	const child = join(parent, "a1");
	mkdirSync(child, { recursive: true });
	const decided = new Promise<void>((resolveDecided) => {
		gate.reached = resolveDecided;
	});
	let release = () => {};
	gate.release = new Promise<void>((resolveRelease) => {
		release = resolveRelease;
	});
	gate.agentDir = child;
	let opened = false;

	const opening = resolveSessionStore(project, { agentDir: child, settings: {} }).then((store) => {
		opened = true;
		return store;
	});
	await decided;
	assert.equal(opened, false);
	const initialSessionPath = defaultSessionDatabasePath(child);
	assert.equal(initialSessionPath, join(child, "workflows", "journal.sqlite"));
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");

	assert.equal(defaultSessionDatabasePath(child), initialSessionPath);
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(child), initialSessionPath);
	assert.equal(opened, false);
	release();

	const store = await opening;
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
