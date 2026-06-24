import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];
const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((item) => item.text ?? "").join("\n");
async function tempDir(): Promise<string> { const dir = join(tmpdir(), `atomic-dir-read-${Date.now()}-${Math.random().toString(16).slice(2)}`); await mkdir(dir, { recursive: true }); tempDirs.push(dir); return dir; }

afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("directory read parity", () => {
	it("renders directory trees by recency with per-directory caps", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "many"));
		await writeFile(join(dir, "old.txt"), "old");
		await writeFile(join(dir, "new.txt"), "new");
		await utimes(join(dir, "old.txt"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
		await utimes(join(dir, "new.txt"), new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
		for (let index = 1; index <= 14; index++) await writeFile(join(dir, "many", `f${String(index).padStart(2, "0")}.txt`), "x");
		const output = text(await createReadToolDefinition(dir).execute("read-dir", { path: "." }, undefined, undefined, {} as never));
		expect(output.indexOf("new.txt")).toBeLessThan(output.indexOf("old.txt"));
		expect(output).toContain("- many/");
		expect(output).toContain("… 2 more");
	});
});
