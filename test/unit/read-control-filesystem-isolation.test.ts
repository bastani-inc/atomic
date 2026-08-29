import assert from "node:assert/strict";
import type { createReadToolDefinition, ReadOperations } from "@bastani/atomic";
import { test } from "vitest";
import { controlFilesystem } from "../helpers/control-filesystem.js";

const signal = new AbortController().signal;

async function execute(
	tool: ReturnType<typeof createReadToolDefinition>,
	path: string,
	ctx: Record<string, object> = {},
) {
	return tool.execute("call", { path }, signal, undefined, ctx as never);
}

function remoteReadOperations(
	content: string,
	paths: string[],
	resolveRemotePath: (path: string, cwd: string) => string,
): ReadOperations {
	return {
		resolvePath: resolveRemotePath,
		async access(path) {
			paths.push(path);
		},
		async readFile() {
			return Buffer.from(content);
		},
	};
}

test("remote read paths and refusals never consult the control filesystem", async () => {
	const { createReadToolDefinition, resolvePath, UnsupportedReadSelectorError } = await import("@bastani/atomic");
	const controlFs = await import("node:fs");
	const controlFsPromises = await import("node:fs/promises");
	controlFilesystem.arm();
	assert.throws(() => controlFs.realpathSync.native("/control-spy-probe"), /control filesystem call/u);
	assert.throws(() => controlFsPromises.access("/control-spy-probe"), /control filesystem call/u);
	const resolveRemotePath = (path: string, cwd: string) =>
		resolvePath(path, cwd, { expandTilde: false, pathStyle: "posix" });
	const paths: string[] = [];
	const read = createReadToolDefinition("/work", {
		operations: remoteReadOperations("remote\n", paths, resolveRemotePath),
	});
	const failingRead = createReadToolDefinition("/work", {
		operations: {
			...remoteReadOperations("", paths, resolveRemotePath),
			async access(path) {
				paths.push(path);
				throw new Error("remote path missing");
			},
		},
	});
	const readWithoutResolver = createReadToolDefinition("/work", {
		operations: {
			async access() {},
			async readFile() {
				return Buffer.from("must not read");
			},
		} as unknown as ReadOperations,
	});

	controlFilesystem.arm();
	try {
		const result = await execute(read, "src/a.txt");
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /remote/u);
		await assert.rejects(execute(failingRead, "missing.txt"), /remote path missing/u);
		await assert.rejects(execute(readWithoutResolver, "ordinary.txt"), TypeError);
		const document = await execute(read, "docs/remote.pdf");
		assert.match(document.content[0]?.type === "text" ? document.content[0].text : "", /Cannot read .pdf file/u);
		for (const [path, selectorKind] of [
			["bundle.zip:src/a.txt", "archive"],
			["state.sqlite:events", "sqlite"],
			["state.sqlite?q=%", "sqlite"],
			["analysis.ipynb", "notebook"],
			["analysis.ipynb?version=1", "notebook"],
			["state.sqlite:events:2-2", "sqlite"],
			["state.sqlite:events:10", "sqlite"],
			["analysis.ipynb#cell", "notebook"],
			["local://src/a.txt", "internal"],
			["skill://tdd/SKILL.md", "internal"],
		] as const) {
			await assert.rejects(
				execute(read, path),
				(error: unknown) =>
					error instanceof UnsupportedReadSelectorError &&
					error.name === "UnsupportedReadSelectorError" &&
					error.selectorKind === selectorKind &&
					error.selector === path,
			);
		}
	} finally {
		controlFilesystem.disarm();
	}

	controlFilesystem.assertUntouched();
	assert.deepEqual(paths, ["/work/src/a.txt", "/work/missing.txt", "/work/docs/remote.pdf"]);
});
