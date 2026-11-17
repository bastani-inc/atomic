import assert from "node:assert/strict";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import { resetStorageHomeCacheForTests } from "../../packages/coding-agent/src/core/storage/file-identity.js";
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
						"select-session",
						"",
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
