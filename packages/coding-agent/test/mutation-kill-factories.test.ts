import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createReadOnlyTools,
	createTool,
	createToolDefinition,
} from "../src/core/tools/index.js";

for (const factory of [createCodingToolDefinitions, createCodingTools, createAllToolDefinitions, createAllTools]) {
	// PR #2482: merging shell kill registration must keep working edit and write tools in every factory.
	test(`${factory.name} keeps edit and write alongside a single kill`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "mutation-kill-factory-"));
		try {
			const path = join(cwd, "target.txt");
			await writeFile(path, "original\n");
			const result = factory(cwd);
			const tools = Array.isArray(result) ? result : Object.values(result);
			const write = tools.find((tool) => tool?.name === "write")!;
			const edit = tools.find((tool) => tool?.name === "edit")!;
			const kill = tools.find((tool) => tool?.name === "kill")!;
			assert.ok(write && edit && kill);
			assert.equal(tools.filter((tool) => tool?.name === "kill").length, 1);
			await write.execute("unread-overwrite", { path, content: "replacement\n" });
			assert.equal(await readFile(path, "utf8"), "replacement\n");
			await writeFile(path, "external\n");
			await edit.execute("edit-after-external-write", {
				path,
				edits: [{ oldText: "external", newText: "edited" }],
			});
			assert.equal(await readFile(path, "utf8"), "edited\n");
			await assert.rejects(kill.execute("kill", { id: "not-owned" }), /requires a supported task owner/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
}

test("factories build working file tools without options", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "tool-factories-"));
	try {
		await writeFile(join(cwd, "a.txt"), "needle\n");
		const write = createTool("write", cwd);
		await write.execute("write", { path: "b.txt", content: "needle b\n" });
		await createTool("edit", cwd).execute("edit", { path: "b.txt", edits: [{ oldText: "b", newText: "c" }] });
		assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "needle c\n");
		const read = await createTool("read", cwd).execute("read", { path: "b.txt" });
		assert.deepEqual(read.content, [{ type: "text", text: "needle c" }]);
		const found = await createTool("search", cwd).execute("search", { pattern: "needle", paths: "a.txt" });
		assert.match(JSON.stringify(found.content), /a\.txt:1: needle/);
		for (const tools of [createReadOnlyToolDefinitions(cwd), createReadOnlyTools(cwd)]) {
			assert.deepEqual(
				tools.map((tool) => tool.name),
				["read", "find", "search", "ls"],
			);
			const readOnly = tools.find((tool) => tool.name === "read")!;
			assert.deepEqual((await readOnly.execute("ro-read", { path: "a.txt" })).content, [
				{ type: "text", text: "needle" },
			]);
			const searchOnly = tools.find((tool) => tool.name === "search")!;
			assert.match(
				JSON.stringify((await searchOnly.execute("ro-search", { pattern: "needle", paths: "a.txt" })).content),
				/a\.txt:1: needle/,
			);
		}
		const definition = createToolDefinition("read", cwd);
		assert.deepEqual(
			(await definition.execute("d-read", { path: "a.txt" }, undefined, undefined, {} as never)).content,
			[{ type: "text", text: "needle" }],
		);
		const searchDefinition = createToolDefinition("search", cwd);
		assert.match(
			JSON.stringify(
				(
					await searchDefinition.execute(
						"d-search",
						{ pattern: "needle", paths: "a.txt" },
						undefined,
						undefined,
						{} as never,
					)
				).content,
			),
			/a\.txt:1: needle/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
