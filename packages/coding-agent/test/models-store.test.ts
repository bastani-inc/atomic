import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@bastani/atomic-ai";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileModelsStore } from "../src/core/models-store.ts";

/**
 * Files whose size, inode number and times the filesystem reports as they were when frozen, as it does for a save that
 * leaves all of them unchanged: on a filesystem with coarse timestamps, two saves within one tick can give the second
 * file the inode number the first freed, and a save that only moves `checkedAt` keeps the size.
 */
const unchanged = vi.hoisted(() => {
	const stats = new Map<string, unknown>();
	return {
		stats,
		async fs(importOriginal: () => Promise<typeof import("node:fs")>) {
			const actual = await importOriginal();
			const statSync = ((path: string, options?: { bigint?: boolean }) =>
				(options?.bigint ? stats.get(String(path)) : undefined) ??
				actual.statSync(path, options as never)) as typeof actual.statSync;
			return { ...actual, statSync, default: { ...actual, statSync } };
		},
	};
});
vi.mock("fs", (importOriginal) => unchanged.fs(importOriginal as never));
vi.mock("node:fs", (importOriginal) => unchanged.fs(importOriginal as never));

/** A process that reads the file at its first argument over and over, and says so once it has read it. */
const KEEPS_READING = `
const { readFileSync, writeSync } = require("node:fs");
for (let told = false; ; told = true) {
	try { readFileSync(process.argv[1]); } catch {}
	if (!told) writeSync(1, "reading\\n");
}`;
/** How many saves the store makes while another process reads: a reader in a loop has the file open for most of them. */
const SAVES_WHILE_READ = 50;

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true });
	}
});

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("FileModelsStore", () => {
	it("persists provider catalogs without replacing unrelated providers", async () => {
		const dir = join(tmpdir(), `pi-models-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "models-store.json");
		const store = new FileModelsStore(path);

		await store.write("one", { models: [model("one", "m1")], checkedAt: 100 });
		await store.write("two", { models: [model("two", "m2")], checkedAt: 200 });

		const reloaded = new FileModelsStore(path);
		expect((await reloaded.read("one"))?.models.map((entry) => entry.id)).toEqual(["m1"]);
		expect((await reloaded.read("one"))?.checkedAt).toBe(100);
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);

		await reloaded.delete("one");
		expect(await reloaded.read("one")).toBeUndefined();
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);
	});

	// A startup refresh reads every provider's entry in turn. Each read used to take the file's exclusive lock, which on
	// Windows cost about 180 ms before the first frame and made a read wait out another process's save.
	it("reads without the save lock, and sees each save from another store, even one made in place", async () => {
		const dir = join(tmpdir(), `pi-models-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "models-store.json");
		const store = new FileModelsStore(path);
		const other = new FileModelsStore(path);
		await other.write("one", { models: [model("one", "m1")], checkedAt: 100 });

		const release = lockfile.lockSync(path, { realpath: false });
		try {
			expect((await store.read("one"))?.checkedAt).toBe(100);
		} finally {
			release();
		}

		await other.write("one", { models: [model("one", "m1")], checkedAt: 200 });
		expect((await store.read("one"))?.checkedAt).toBe(200);
		const edited = JSON.parse(readFileSync(path, "utf8")) as Record<string, { checkedAt: number }>;
		edited.one!.checkedAt = 300;
		writeFileSync(path, JSON.stringify(edited));
		expect((await store.read("one"))?.checkedAt).toBe(300);
	});

	it("sees another store's save even when the file's size, inode and times are as they were", async () => {
		const dir = join(tmpdir(), `pi-models-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "models-store.json");
		const store = new FileModelsStore(path);
		const other = new FileModelsStore(path);
		await other.write("one", { models: [model("one", "m1")], checkedAt: 100 });
		expect((await store.read("one"))?.checkedAt).toBe(100);

		unchanged.stats.set(path, statSync(path, { bigint: true }));
		try {
			await other.write("one", { models: [model("one", "m1")], checkedAt: 200 });
			expect((await store.read("one"))?.checkedAt).toBe(200);
		} finally {
			unchanged.stats.delete(path);
		}
	});

	// Reads take no lock, so another process may have the file open while a save replaces it. Windows refuses to rename
	// over an open file for that moment (EPERM); the save must wait it out, not fail and lose the catalog.
	it("keeps every save made while another process keeps reading the file", async () => {
		const dir = join(tmpdir(), `pi-models-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "models-store.json");
		const store = new FileModelsStore(path);
		await store.write("one", { models: [model("one", "m1")], checkedAt: 0 });
		const reader = spawn(process.execPath, ["-e", KEEPS_READING, path], { stdio: ["ignore", "pipe", "inherit"] });
		const exited = once(reader, "exit");
		try {
			await once(reader.stdout, "data");
			for (let save = 1; save <= SAVES_WHILE_READ; save++) {
				await store.write("one", { models: [model("one", "m1")], checkedAt: save });
			}
		} finally {
			reader.kill();
			await exited;
		}
		expect((await new FileModelsStore(path).read("one"))?.checkedAt).toBe(SAVES_WHILE_READ);
	});
});
