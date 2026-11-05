import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEditMatchError } from "../src/core/tools/file-tool-errors.ts";
import { createCodingToolDefinitions, type ToolDef } from "../src/core/tools/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
}

async function codingTools(): Promise<{ dir: string; tool: (name: string) => ToolDef }> {
	const dir = await mkdtemp(join(tmpdir(), "edit-after-bash-"));
	tempDirs.push(dir);
	const tools = createCodingToolDefinitions(dir, { bash: { exposeSessionEnvironment: false } });
	return { dir, tool: (name) => tools.find((candidate) => candidate.name === name)! };
}

describe.skipIf(process.platform === "win32")("edit after a shell changed the file (#4328)", () => {
	it("edits by exact text after python -c and sed -i rewrote the file between read and edit", async () => {
		const { dir, tool } = await codingTools();
		const path = join(dir, "config.py");
		await writeFile(path, 'name = "alpha"\nretries = 1\ntimeout = 5\n');

		const readText = textOf(await tool("read").execute("read", { path: "config.py" }));
		expect(readText).toBe('name = "alpha"\nretries = 1\ntimeout = 5');

		const python = await tool("bash").execute("python", {
			command: `python3 -c "import pathlib; p = pathlib.Path('config.py'); p.write_text(p.read_text().replace('retries = 1', 'retries = 3'))"`,
		});
		expect(textOf(python)).not.toMatch(/exited with code/);
		const sed = await tool("bash").execute("sed", {
			command: "sed -i.bak 's/timeout = 5/timeout = 30/' config.py && rm config.py.bak",
		});
		expect(textOf(sed)).not.toMatch(/exited with code/);
		expect(await readFile(path, "utf8")).toBe('name = "alpha"\nretries = 3\ntimeout = 30\n');

		const edited = await tool("edit").execute("edit", {
			path: "config.py",
			edits: [
				{ oldText: 'name = "alpha"', newText: 'name = "beta"' },
				{ oldText: "timeout = 30", newText: "timeout = 60" },
			],
		});

		expect(textOf(edited)).toBe("Successfully replaced 2 block(s) in config.py.");
		expect(await readFile(path, "utf8")).toBe('name = "beta"\nretries = 3\ntimeout = 60\n');
	});

	it("rejects text the shell removed with a typed no-match error and leaves the file unchanged", async () => {
		const { dir, tool } = await codingTools();
		const path = join(dir, "notes.txt");
		await writeFile(path, "keep\nstale line\n");
		await tool("read").execute("read", { path: "notes.txt" });
		await tool("bash").execute("sed", {
			command: "sed -i.bak 's/stale line/fresh line/' notes.txt && rm notes.txt.bak",
		});

		const failure = await tool("edit")
			.execute("edit", { path: "notes.txt", edits: [{ oldText: "stale line", newText: "edited" }] })
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(isEditMatchError(failure)).toBe(true);
		expect(failure).toMatchObject({ code: "text-not-found", fields: { path: "notes.txt", editIndex: 0 } });
		expect(await readFile(path, "utf8")).toBe("keep\nfresh line\n");
	});
});
