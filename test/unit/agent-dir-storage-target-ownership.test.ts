import assert from "node:assert/strict";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import {
	resetStorageHomeCacheForTests,
	storageHomeDir,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

let root: string;
const STORAGE_PROCESS_TIMEOUT_MS = 60_000;

beforeEach(() => {
	root = makeTempDirectory("storage-target-ownership-");
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

for (const source of ["settings", "env", "cli"] as const) {
	test(
		`different processes preserve distinct external relative targets selected by ${source} without sharing a claimed target (#5242)`,
		() => {
			const first = join(root, "a1");
			const second = join(root, "a2");
			for (const agent of [first, second]) mkdirSync(agent, { recursive: true });
			for (const target of ["a1.sqlite", "a2.sqlite"]) writeFileSync(join(root, target), "history");
			writeFileSync(join(first, "settings.json"), JSON.stringify({ sessions: { storage: { path: "a2.sqlite" } } }));
			const select = (agent: string, target: string) => {
				const selection = { path: target };
				const child = spawnSyncCollect(
					[
						bunExecutable(),
						resolve("test/fixtures/agent-dir-storage-process-child.ts"),
						agent,
						JSON.stringify(source === "settings" ? { sessions: { storage: selection } } : {}),
						...(source === "cli" ? [JSON.stringify(selection)] : []),
					],
					{
						env: {
							...process.env,
							...(source === "env" ? { ATOMIC_SESSIONS_STORAGE: JSON.stringify(selection) } : {}),
						},
						timeout: STORAGE_PROCESS_TIMEOUT_MS,
					},
				);
				assert.equal(child.exitCode, 0, child.stderr.toString());
				return JSON.parse(child.stdout.toString()) as { kind: string; path: string };
			};
			assert.deepEqual(select(first, "a1.sqlite"), { kind: "sqlite", path: join(root, "a1.sqlite") });
			assert.deepEqual(select(second, "a2.sqlite"), { kind: "sqlite", path: join(root, "a2.sqlite") });
			assert.deepEqual(select(second, "a1.sqlite"), { kind: "sqlite", path: join(second, "a1.sqlite") });
			assert.deepEqual(select(first, "a1.sqlite"), { kind: "sqlite", path: join(root, "a1.sqlite") });
		},
		STORAGE_PROCESS_TIMEOUT_MS,
	);
}

for (const alias of ["symlink", "hardlink"] as const) {
	test(`relative targets that ${alias} the same database have only one sibling owner (#5242)`, () => {
		const first = join(root, "a1");
		const second = join(root, "a2");
		for (const agent of [first, second]) mkdirSync(agent, { recursive: true });
		const firstTarget = alias === "symlink" ? join("first-store", "history.sqlite") : "first.sqlite";
		const secondTarget = alias === "symlink" ? join("second-store", "history.sqlite") : "second.sqlite";
		if (alias === "symlink") mkdirSync(join(root, "first-store"));
		writeFileSync(join(root, firstTarget), "history");
		if (alias === "symlink") symlinkSync(join(root, "first-store"), join(root, "second-store"), "junction");
		else linkSync(join(root, firstTarget), join(root, secondTarget));
		const select = (agent: string, path: string) =>
			selectSessionStorage(root, { agentDir: agent, settings: { sessions: { storage: { path } } } });
		assert.deepEqual(select(first, firstTarget), { kind: "sqlite", path: join(root, firstTarget) });
		assert.deepEqual(select(second, secondTarget), { kind: "sqlite", path: join(second, secondTarget) });
	});
}

test("a cached isolated target cannot become a hard-link alias of a sibling's claimed history (#5242)", () => {
	const first = join(root, "a1");
	const second = join(root, "a2");
	for (const agent of [first, second]) mkdirSync(agent);
	const shared = join(root, "history.sqlite");
	writeFileSync(shared, "history");
	const settings = { sessions: { storage: { path: "history.sqlite" } } };
	assert.deepEqual(selectSessionStorage(root, { agentDir: first, settings }), { kind: "sqlite", path: shared });
	assert.deepEqual(selectSessionStorage(root, { agentDir: second, settings }), {
		kind: "sqlite",
		path: join(second, "history.sqlite"),
	});
	linkSync(shared, join(second, "history.sqlite"));
	assert.throws(() => selectSessionStorage(root, { agentDir: second, settings }), /owned by another agent directory/);
});

test.each(["file", "directory"])("a cached default target still rejects a sibling's new %s alias (#5242)", (kind) => {
	const home = join(root, `default-cache-${kind}`);
	const atomic = join(home, ".atomic");
	const agent = join(atomic, "agent");
	const sibling = join(atomic, "custom");
	mkdirSync(agent, { recursive: true });
	mkdirSync(sibling);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	assert.equal(storageHomeDir(agent, {}), atomic);
	assert.equal(storageHomeDir(sibling, {}), sibling);
	const foreign = join(atomic, "foreign");
	if (kind === "file") writeFileSync(foreign, "history");
	else mkdirSync(foreign);
	const selected = (owner: string, name: string) =>
		selectSessionStorage(root, {
			agentDir: owner,
			settings: { sessions: { storage: kind === "file" ? { path: name } : { dir: name } } },
		});
	const selection = (location: string) =>
		kind === "file" ? { kind: "sqlite", path: location } : { kind: "jsonl", dir: location };
	assert.deepEqual(selected(sibling, "foreign"), selection(foreign));
	assert.deepEqual(selected(agent, "history"), selection(join(atomic, "history")));
	assert.deepEqual(selected(agent, "history"), selection(join(atomic, "history")));
	if (kind === "file") linkSync(foreign, join(atomic, "history"));
	else symlinkSync(foreign, join(atomic, "history"), "junction");
	assert.deepEqual(selected(agent, "history"), selection(join(agent, "history")));
});

test("an adopted agent retains a legacy relative target beside its alias when its home has no matching target (#5242)", () => {
	const parent = join(root, "adopted");
	const agent = join(parent, "agent");
	const aliasParent = join(root, "alias-parent");
	const alias = join(aliasParent, "alias");
	mkdirSync(agent, { recursive: true });
	mkdirSync(aliasParent);
	mkdirSync(join(parent, "workflows"));
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(storageHomeDir(agent, {}), parent);
	symlinkSync(agent, alias, "junction");
	const legacy = join(aliasParent, "legacy.sqlite");
	writeFileSync(legacy, "history");
	assert.deepEqual(
		selectSessionStorage(root, { agentDir: alias, settings: { sessions: { storage: { path: "legacy.sqlite" } } } }),
		{ kind: "sqlite", path: legacy },
	);
	assert.equal(storageHomeDir(agent, {}), parent);
});

test("an alias-parent legacy target keeps the owner's recorded reservation before its first target lookup (#5242)", () => {
	const parent = join(root, "adopted");
	const agent = join(parent, "agent");
	const aliasParent = join(root, "reserved-parent");
	const owner = join(aliasParent, "owner");
	const alias = join(aliasParent, "alias");
	for (const directory of [agent, owner, join(parent, "workflows"), join(aliasParent, "workflows")])
		mkdirSync(directory, { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	writeFileSync(join(aliasParent, "workflows", "journal.sqlite"), "");
	writeFileSync(join(aliasParent, "team.sqlite"), "history");
	const settings = { sessions: { storage: { path: "team.sqlite" } } };
	assert.equal(storageHomeDir(agent, {}), parent);
	assert.equal(storageHomeDir(owner, settings), aliasParent);
	symlinkSync(agent, alias, "junction");
	assert.deepEqual(selectSessionStorage(root, { agentDir: alias, settings }), {
		kind: "sqlite",
		path: join(alias, "team.sqlite"),
	});
	assert.deepEqual(selectSessionStorage(root, { agentDir: owner, settings }), {
		kind: "sqlite",
		path: join(aliasParent, "team.sqlite"),
	});
});

test("an adopted agent reopened through an external alias and a default-agent alias share target claims with siblings (#5242)", () => {
	const parent = join(root, "parent");
	const other = join(root, "other");
	const first = join(parent, "first");
	const second = join(parent, "second");
	const alias = join(other, "alias");
	const secondAlias = join(other, "second-alias");
	for (const dir of [first, second, other, join(parent, "workflows")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	writeFileSync(join(parent, "team.sqlite"), "history");
	assert.equal(storageHomeDir(first, {}), parent);
	symlinkSync(first, alias, "junction");
	symlinkSync(second, secondAlias, "junction");
	const settings = { sessions: { storage: { path: "team.sqlite" } } };
	assert.deepEqual(selectSessionStorage(root, { agentDir: alias, settings }), {
		kind: "sqlite",
		path: join(parent, "team.sqlite"),
	});
	assert.deepEqual(selectSessionStorage(root, { agentDir: second, settings }), {
		kind: "sqlite",
		path: join(second, "team.sqlite"),
	});
	assert.deepEqual(selectSessionStorage(root, { agentDir: secondAlias, settings }), {
		kind: "sqlite",
		path: join(secondAlias, "team.sqlite"),
	});

	const home = join(root, "default-alias-home");
	const canonical = join(home, ".atomic", "agent");
	const defaultAlias = join(home, "link-agent");
	const homeSibling = join(home, "sibling");
	const atomicSibling = join(home, ".atomic", "custom");
	for (const dir of [canonical, homeSibling, atomicSibling, join(home, "workflows")])
		mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, "workflows", "journal.sqlite"), "");
	writeFileSync(join(home, "team.sqlite"), "history");
	symlinkSync(canonical, defaultAlias, "junction");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(defaultAlias, {}), home);
	assert.deepEqual(selectSessionStorage(root, { agentDir: canonical, settings }), {
		kind: "sqlite",
		path: join(home, "team.sqlite"),
	});
	assert.deepEqual(selectSessionStorage(root, { agentDir: homeSibling, settings }), {
		kind: "sqlite",
		path: join(homeSibling, "team.sqlite"),
	});
	assert.throws(
		() =>
			selectSessionStorage(root, {
				agentDir: atomicSibling,
				settings: { sessions: { storage: { path: "../team.sqlite" } } },
			}),
		/owned by another agent directory/,
	);
});
