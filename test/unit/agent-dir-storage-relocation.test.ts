import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	defaultSessionDatabasePath,
	fileIdentity,
	resetStorageHomeCacheForTests,
	storagePathBaseDir,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
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
