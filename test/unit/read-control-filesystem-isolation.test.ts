import assert from "node:assert/strict";
import { createReadToolDefinition, type ReadOperations, resolvePath } from "@bastani/atomic";
import { test } from "vitest";
import { installControlFilesystemFailureSpy } from "../helpers/control-filesystem.js";

const signal = new AbortController().signal;

async function execute(tool: ReturnType<typeof createReadToolDefinition>, path: string) {
	return tool.execute("call", { path }, signal, undefined, {} as never);
}

function remoteReadOperations(content: string, paths: string[]): ReadOperations {
	return {
		resolvePath(path, cwd) {
			return resolvePath(path, cwd, { expandTilde: false, pathStyle: "posix" });
		},
		async access(path) {
			paths.push(path);
		},
		async readFile() {
			return Buffer.from(content);
		},
	};
}

test("custom read path resolution never consults the control filesystem", async () => {
	const paths: string[] = [];
	const read = createReadToolDefinition("/work", { operations: remoteReadOperations("remote\n", paths) });
	const failingRead = createReadToolDefinition("/work", {
		operations: {
			...remoteReadOperations("", paths),
			async access(path) {
				paths.push(path);
				throw new Error("remote path missing");
			},
		},
	});
	const controlFilesystem = installControlFilesystemFailureSpy();

	try {
		const result = await execute(read, "src/a.txt");
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /remote/u);
		await assert.rejects(execute(failingRead, "missing.txt"), /remote path missing/u);
		controlFilesystem.assertUntouched();
	} finally {
		controlFilesystem.restore();
	}

	assert.deepEqual(paths, ["/work/src/a.txt", "/work/missing.txt"]);
});
