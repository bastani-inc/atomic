import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { prebuildRepository } from "../src/core/resume/blueprint/prebuild.js";
import {
	pooledWorktreeHolder,
	pooledWorktreePath,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import { seedManifestPath } from "../src/core/worktree-snapshot/seeds.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import { forThisHost } from "./helpers/blueprint-fixtures.js";

const refusals = vi.hoisted(() => ({
	target: "",
	attempts: 0,
	elapsedMs: 0,
	active: false,
	onRefusal: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const mkdir = ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
		if (String(path) !== refusals.target) return (actual.mkdir as (...args: unknown[]) => void)(path, ...rest);
		refusals.attempts++;
		refusals.onRefusal?.();
		const error = Object.assign(new Error(`EPERM: operation not permitted, mkdir '${String(path)}'`), {
			code: "EPERM",
			syscall: "mkdir",
			path: String(path),
		});
		const callback = rest.at(-1) as (error: NodeJS.ErrnoException) => void;
		process.nextTick(() => callback(error));
	}) as typeof actual.mkdir;
	return { ...actual, default: { ...actual, mkdir }, mkdir };
});

vi.mock("node:timers/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:timers/promises")>();
	const setTimeout: typeof actual.setTimeout = (delay, value, options) => {
		if (!refusals.active) return actual.setTimeout(delay, value, options);
		refusals.elapsedMs += delay ?? 0;
		return actual.setTimeout(0, value, options);
	};
	return { ...actual, setTimeout };
});

useTemporaryAgentDir();

let sandbox: GitSandbox;
const originalPlatform = process.platform;

beforeEach(() => {
	sandbox = new GitSandbox();
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	vi.restoreAllMocks();
	refusals.target = "";
	refusals.attempts = 0;
	refusals.elapsedMs = 0;
	refusals.active = false;
	refusals.onRefusal = undefined;
	sandbox.dispose();
});

test("a persistent seed-lock EPERM reports failure without losing just-built output (#5320)", async () => {
	const { clone, remote } = await sandbox.remoteWithClone("repo", {
		"README.md": "hello\n",
		".gitignore": "build/\n",
		".atomic/blueprint.yaml": forThisHost("maintenance: mkdir -p build && echo built > build/out.txt\n"),
		".atomic/settings.json": JSON.stringify({ resume: { cache: [{ paths: ["build"], kind: "build" }] } }),
	});
	const storeDir = sandbox.path("host");
	const repository = repositoryIdOf([remote]);
	const path = pooledWorktreePath(storeDir, repository, 0 as SlotNumber);
	refusals.target = `${seedManifestPath(storeDir, repository)}.lock`;
	refusals.onRefusal = () => {
		if (refusals.active) return;
		const startedAt = Date.now();
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		vi.spyOn(Date, "now").mockImplementation(() => startedAt + refusals.elapsedMs);
		refusals.active = true;
	};

	await assert.rejects(
		prebuildRepository(clone, {
			agentDir: sandbox.path("agent"),
			storeDir,
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			maxIdlePerRepository: 2,
			park: true,
		}),
		{ code: "EPERM", syscall: "mkdir", path: refusals.target },
	);

	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	vi.restoreAllMocks();
	refusals.active = false;
	assert.equal(refusals.elapsedMs, 10_000);
	assert.ok(refusals.attempts > 1);
	assert.equal(existsSync(join(path, "build", "out.txt")), true, "the completed build must remain in its worktree");
	assert.equal(readFileSync(join(path, "build", "out.txt"), "utf8").trim(), "built");
	assert.equal(existsSync(seedManifestPath(storeDir, repository)), false);
	assert.deepEqual(readdirSync(join(storeDir, "seeds")), []);
	const holder = await pooledWorktreeHolder(storeDir, path);
	assert.notEqual(holder, "unpooled");
	if (holder === "unpooled") throw new Error(holder);
	assert.equal(holder.held, false);
});
