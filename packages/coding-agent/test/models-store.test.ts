import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@bastani/atomic-ai";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { FileModelsStore } from "../src/core/models-store.ts";

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
});
