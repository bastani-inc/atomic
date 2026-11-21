import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test, vi } from "vitest";
// Imported when the file is collected rather than in the test: the module imports the agent package, whose first
// compile on a loaded machine would otherwise take most of the test's own budget. The mocks below still apply.
import { clearCloneCache, extractGitHub } from "../../packages/web-access/github-extract.js";
import { fileExists, makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const boundary = vi.hoisted(() => ({ path: "", clone: vi.fn() }));
vi.mock("node:child_process", () => ({
	execFile: boundary.clone,
	spawn: (command: string, args: string[] = [], options: object = {}) => {
		const child = Object.assign(new EventEmitter(), { kill: () => true });
		boundary.clone(command, args, options, (err: Error | null) => {
			child.emit("exit", err ? 1 : 0, null);
			child.emit("close", err ? 1 : 0, null);
		});
		return child;
	},
}));
vi.mock("../../packages/web-access/config-paths.ts", () => ({ findReadableConfigPath: () => boundary.path }));

// #3105: same-repository clone work and deletion belong to the invoking owner.
test("closing a clone owner preserves its sibling's same-repository files and cache", async () => {
	const directory = makeTempDirectory("web-owner-clone-");
	boundary.path = join(directory, "web-search.json");
	await writeFileEnsuringDir(boundary.path, JSON.stringify({ githubClone: { clonePath: join(directory, "clones") } }));
	const key = Symbol.for("atomic.builtin-diagnostic-context.v1");
	const host = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<object> };
	const previous = host[key];
	const context = new AsyncLocalStorage<object>();
	host[key] = context;
	const reporter = () => Object.assign(() => {}, { [Symbol.for("atomic.builtin-owner.v1")]: {} });
	const first = reporter();
	const second = reporter();
	const paths: string[] = [];
	boundary.clone.mockImplementation(
		(_command: string, args: string[], _options: object, callback: (error: Error | null) => void) => {
			if (args[0] === "--version") queueMicrotask(() => callback(null));
			else {
				const path = args[3]!;
				paths.push(path);
				void writeFileEnsuringDir(join(path, "README.md"), "Owned repository content").then(() => callback(null));
			}
			return Object.assign(new EventEmitter(), { kill: () => true });
		},
	);
	try {
		const url = "https://github.com/example/repository";
		assert.match(
			(await context.run(first, () => extractGitHub(url, undefined, true)))!.content,
			/Owned repository content/,
		);
		assert.match(
			(await context.run(second, () => extractGitHub(url, undefined, true)))!.content,
			/Owned repository content/,
		);
		assert.equal(paths.length, 2);
		assert.notEqual(paths[0], paths[1]);
		await context.run(second, clearCloneCache);
		await context.run(second, clearCloneCache);
		assert.equal(await fileExists(join(paths[0]!, "README.md")), true);
		assert.equal(await fileExists(join(paths[1]!, "README.md")), false);
		assert.match(
			(await context.run(first, () => extractGitHub(url, undefined, true)))!.content,
			/Owned repository content/,
		);
		assert.equal(paths.length, 2);
	} finally {
		await context.run(first, clearCloneCache);
		await context.run(second, clearCloneCache);
		host[key] = previous;
		removeTempDirectory(directory);
	}
});
