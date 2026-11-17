import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const unsupportedLinks = vi.hoisted(() =>
	vi.fn(() => {
		throw Object.assign(new Error("Hard links are unsupported"), { code: "EOPNOTSUPP" });
	}),
);
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	linkSync: unsupportedLinks,
}));
vi.resetModules();
const { defaultSessionDatabasePath, resetStorageHomeCacheForTests } = await import(
	"../../packages/coding-agent/src/core/storage/file-identity.js"
);

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-without-links-");
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

test("an agent keeps its legacy history and sibling isolation when hard links are unsupported (#5242)", () => {
	const first = join(root, "a1");
	const second = join(root, "a2");
	for (const agent of [first, second]) mkdirSync(agent);
	mkdirSync(join(root, "workflows"));
	const legacy = join(root, "workflows", "journal.sqlite");
	writeFileSync(legacy, "");
	assert.equal(defaultSessionDatabasePath(first, {}), legacy);
	assert.equal(defaultSessionDatabasePath(second, {}), join(second, "workflows", "journal.sqlite"));
	resetStorageHomeCacheForTests();
	assert.equal(defaultSessionDatabasePath(first, {}), legacy);
	assert.equal(defaultSessionDatabasePath(second, {}), join(second, "workflows", "journal.sqlite"));
	assert.ok(unsupportedLinks.mock.calls.length > 0);
});

test.skipIf(process.platform === "win32")(
	"a writable agent inside a read-only POSIX parent can select and persist its own store (#5242)",
	() => {
		const parent = join(root, "read-only");
		const agent = join(parent, "agent");
		mkdirSync(agent, { recursive: true });
		chmodSync(parent, 0o555);
		try {
			assert.equal(defaultSessionDatabasePath(agent, {}), join(agent, "workflows", "journal.sqlite"));
			assert.ok(existsSync(join(agent, ".atomic-storage-home")));
			resetStorageHomeCacheForTests();
			assert.equal(defaultSessionDatabasePath(agent, {}), join(agent, "workflows", "journal.sqlite"));
		} finally {
			chmodSync(parent, 0o755);
		}
	},
);
