import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { EditBatchCoordinator } from "../src/core/tools/edit-batch.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "atomic-edit-batch-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

describe("EditBatchCoordinator", () => {
	it("absorbs pending siblings whose paths are a tagged subset of the leader", () => {
		const batcher = new EditBatchCoordinator<string>();
		const leader = batcher.announce("leader", new Map([["a.ts", "AAAA"]]));
		const sibling = batcher.announce("sibling", new Map([["a.ts", "AAAA"]]));
		const otherFile = batcher.announce("other", new Map([["b.ts", "AAAA"]]));
		const otherTag = batcher.announce("tag", new Map([["a.ts", "BBBB"]]));
		expect(batcher.takeCompatible(leader)).toEqual([leader, sibling]);
		expect(otherFile.settled).toBe(false);
		expect(otherTag.settled).toBe(false);
	});

	it("rejects aborted siblings instead of absorbing them", async () => {
		const batcher = new EditBatchCoordinator<string>();
		const controller = new AbortController();
		const leader = batcher.announce("leader", new Map([["a.ts", "AAAA"]]));
		const aborted = batcher.announce("aborted", new Map([["a.ts", "AAAA"]]), controller.signal);
		controller.abort();
		expect(batcher.takeCompatible(leader)).toEqual([leader]);
		await expect(aborted.promise).rejects.toThrow("Operation aborted");
	});
});

describe("parallel hashline edit batching", () => {
	it("lands four non-overlapping same-tag edits with one write", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "sessions.ts");
		const original = "alpha\nbeta\ngamma\ndelta\n";
		await writeFile(filePath, original, "utf8");
		const store = createHashlineSnapshotStore();
		const tag = store.record(filePath, dir, original).tag;
		let writes = 0;
		const edit = createEditTool(dir, {
			hashlineStore: store,
			operations: {
				access,
				readFile,
				writeFile: async (path, content) => {
					writes += 1;
					await writeFile(path, content, "utf8");
				},
			},
		});

		const results = await Promise.all([
			edit.execute("c1", { input: `[sessions.ts#${tag}]\nreplace 1..1:\n+ALPHA` }),
			edit.execute("c2", { input: `[sessions.ts#${tag}]\nreplace 2..2:\n+BETA` }),
			edit.execute("c3", { input: `[sessions.ts#${tag}]\nreplace 3..3:\n+GAMMA` }),
			edit.execute("c4", { input: `[sessions.ts#${tag}]\nreplace 4..4:\n+DELTA` }),
		]);

		expect(writes).toBe(1);
		expect(await readFile(filePath, "utf8")).toBe("ALPHA\nBETA\nGAMMA\nDELTA\n");
		expect(text(results[0]!)).toContain("Applied 4 parallel edit calls as one snapshot-anchored batch.");
		const tags = new Set(results.map((result) => text(result).match(/#([0-9A-F]{4})/)?.[1]));
		expect(tags.size).toBe(1);
	});

	it("does not batch parallel edits of different files", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), "one\n", "utf8");
		await writeFile(join(dir, "b.txt"), "two\n", "utf8");
		const store = createHashlineSnapshotStore();
		const aTag = store.record(join(dir, "a.txt"), dir, "one\n").tag;
		const bTag = store.record(join(dir, "b.txt"), dir, "two\n").tag;
		let writes = 0;
		const edit = createEditTool(dir, {
			hashlineStore: store,
			operations: {
				access,
				readFile,
				writeFile: async (path, content) => {
					writes += 1;
					await writeFile(path, content, "utf8");
				},
			},
		});

		await Promise.all([
			edit.execute("a", { input: `[a.txt#${aTag}]\nreplace 1..1:\n+ONE` }),
			edit.execute("b", { input: `[b.txt#${bTag}]\nreplace 1..1:\n+TWO` }),
		]);

		expect(writes).toBe(2);
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("ONE\n");
		expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("TWO\n");
	});

	it("recovers a sequential same-tag follow-up after the first write", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "chain.txt");
		const original = "one\ntwo\nthree\n";
		await writeFile(filePath, original, "utf8");
		const store = createHashlineSnapshotStore();
		const tag = store.record(filePath, dir, original).tag;
		const edit = createEditTool(dir, { hashlineStore: store });

		await edit.execute("first", { input: `[chain.txt#${tag}]\nreplace 1..1:\n+ONE` });
		const second = await edit.execute("second", { input: `[chain.txt#${tag}]\nreplace 3..3:\n+THREE` });

		expect(await readFile(filePath, "utf8")).toBe("ONE\ntwo\nTHREE\n");
		expect(text(second)).toMatch(/Recovered/);
	});

	it("leaves the file unchanged when a batched apply fails", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "fail.txt");
		const original = "one\ntwo\n";
		await writeFile(filePath, original, "utf8");
		const store = createHashlineSnapshotStore();
		const tag = store.record(filePath, dir, original).tag;
		const edit = createEditTool(dir, { hashlineStore: store });

		const results = await Promise.allSettled([
			edit.execute("ok", { input: `[fail.txt#${tag}]\nreplace 1..1:\n+ONE` }),
			edit.execute("bad", { input: `[fail.txt#${tag}]\nreplace 99..99:\n+MISSING` }),
		]);

		expect(results.every((result) => result.status === "rejected")).toBe(true);
		expect(await readFile(filePath, "utf8")).toBe(original);
	});

	it("lets a multi-file edit absorb a single-file sibling on one of its paths", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), "one\n", "utf8");
		await writeFile(join(dir, "b.txt"), "two\n", "utf8");
		const store = createHashlineSnapshotStore();
		const aTag = store.record(join(dir, "a.txt"), dir, "one\n").tag;
		const bTag = store.record(join(dir, "b.txt"), dir, "two\n").tag;
		let writes = 0;
		const edit = createEditTool(dir, {
			hashlineStore: store,
			operations: {
				access,
				readFile,
				writeFile: async (path, content) => {
					writes += 1;
					await writeFile(path, content, "utf8");
				},
			},
		});

		await Promise.all([
			edit.execute("multi", {
				input: `[a.txt#${aTag}]\nreplace 1..1:\n+ONE\n\n[b.txt#${bTag}]\nreplace 1..1:\n+TWO`,
			}),
			edit.execute("single", { input: `[a.txt#${aTag}]\ninsert tail:\n+tail` }),
		]);

		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("ONE\ntail\n");
		expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("TWO\n");
		expect(writes).toBeGreaterThanOrEqual(2);
	});
});
