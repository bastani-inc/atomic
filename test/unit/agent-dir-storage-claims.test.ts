import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	resetStorageHomeCacheForTests,
	storageHomeDir,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";
import {
	selectProcessStorage,
	validateProcessStorage,
} from "../../packages/coding-agent/src/core/storage/process-selection.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, sleep, spawnProcess } from "../helpers/runtime.js";

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-claims-");
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

const CLAIM_PROCESS_TIMEOUT_MS = 60_000;
const CLAIM_START_TIMEOUT_MS = 30_000;

test(
	"concurrent storage claim publishers keep exactly one complete owner record (#5242)",
	async () => {
		const claim = join(root, "claim");
		const start = join(root, "start");
		const ready = ["first", "second", "third"].map((name) => join(root, name));
		const children = ready.map((path, index) => {
			const contents = `${index}:${"owner".repeat(1_000)}\n`;
			const child = spawnProcess(
				[bunExecutable(), resolve("test/fixtures/agent-dir-storage-claim-child.ts"), claim, path, start, contents],
				{ stderr: "pipe", timeout: CLAIM_PROCESS_TIMEOUT_MS },
			);
			return {
				child,
				stdout: new Response(child.stdout).text(),
				stderr: new Response(child.stderr).text(),
			};
		});
		try {
			const deadline = Date.now() + CLAIM_START_TIMEOUT_MS;
			while (!ready.every((path) => existsSync(path))) {
				assert.ok(Date.now() < deadline, "all claim publishers reached the start barrier");
				await sleep(10);
			}
			writeFileSync(start, "start");
			const results = await Promise.all(
				children.map(async ({ child, stdout, stderr }) => {
					assert.equal(await child.exited, 0, await stderr);
					return JSON.parse(await stdout) as { claimed: boolean; contents: string };
				}),
			);
			const winners = results.filter((result) => result.claimed);
			assert.equal(winners.length, 1);
			assert.equal(readFileSync(claim, "utf8"), winners[0]?.contents);
		} finally {
			for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.all(children.map(({ child }) => child.exited));
		}
	},
	CLAIM_PROCESS_TIMEOUT_MS,
);

test("a storage-token-only profile keeps its legacy parent store ahead of a new sibling (#5242)", () => {
	const original = join(root, "original");
	const fresh = join(root, "fresh");
	mkdirSync(original);
	mkdirSync(fresh);
	mkdirSync(join(root, "workflows"));
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	writeFileSync(join(original, "storage-token.fixture"), "fixture-token");
	assert.equal(storageHomeDir(fresh, {}), fresh);
	assert.equal(storageHomeDir(original, {}), root);
});

test("an extension-only profile named workflows retains priority when a fresh sibling starts first (#5242)", () => {
	const original = join(root, "workflows");
	const fresh = join(root, "fresh");
	mkdirSync(join(original, "extensions"), { recursive: true });
	mkdirSync(fresh);
	writeFileSync(join(original, "journal.sqlite"), "");
	assert.equal(storageHomeDir(fresh, {}), fresh);
	assert.equal(storageHomeDir(original, {}), root);
});

test("default agent resource directories are not mistaken for competing profiles during nested legacy adoption (#5242)", () => {
	const home = join(root, "home");
	const parent = join(home, ".atomic", "agent");
	const agent = join(parent, "profile");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(parent, "skills", "extensions"), { recursive: true });
	mkdirSync(join(parent, "workflows"));
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(storageHomeDir(agent, {}), parent);
});

test("a relative target naming only the parent directory does not adopt the default stores (#5242)", () => {
	const agent = join(root, "agent");
	mkdirSync(agent);
	assert.equal(storageHomeDir(agent, { sessions: { storage: { dir: "." } } }), agent);
});

test("validating unused process storage does not publish or settle an agent's home (#5242)", () => {
	vi.stubEnv("ATOMIC_SESSIONS_STORAGE", "{}");
	for (const [index, operation] of [
		validateProcessStorage,
		(agent: string) => selectProcessStorage("shared", agent),
	].entries()) {
		const parent = join(root, `validation-${index}`);
		const agent = join(parent, "agent");
		mkdirSync(agent, { recursive: true });
		operation(agent);
		assert.equal(existsSync(join(agent, ".atomic-storage-home")), false);
		mkdirSync(join(parent, "workflows"));
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
		assert.equal(storageHomeDir(agent, {}), parent);
	}
});
