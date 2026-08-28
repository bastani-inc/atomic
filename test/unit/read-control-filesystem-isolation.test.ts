import assert from "node:assert/strict";
import { test, vi } from "vitest";

const controlFs = vi.hoisted(() => ({ armed: false, calls: [] as string[] }));

function guardedFilesystemModule(module: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(module).map(([name, value]) => [
			name,
			typeof value === "function"
				? (...args: unknown[]) => {
						if (controlFs.armed) {
							controlFs.calls.push(name);
							throw new Error(`control filesystem call: ${name}`);
						}
						return Reflect.apply(value, module, args);
					}
				: value,
		]),
	);
}

vi.mock("node:fs", async (importOriginal) => guardedFilesystemModule(await importOriginal<Record<string, unknown>>()));
vi.mock("node:fs/promises", async (importOriginal) =>
	guardedFilesystemModule(await importOriginal<Record<string, unknown>>()),
);
vi.mock("fs", async (importOriginal) => guardedFilesystemModule(await importOriginal<Record<string, unknown>>()));
vi.mock("fs/promises", async (importOriginal) =>
	guardedFilesystemModule(await importOriginal<Record<string, unknown>>()),
);

import {
	createReadToolDefinition,
	type ReadOperations,
	resolvePath,
	UnsupportedReadSelectorError,
} from "@bastani/atomic";

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

test("remote read paths and refusals never consult the control filesystem", async () => {
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

	controlFs.armed = true;
	try {
		const result = await execute(read, "src/a.txt");
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /remote/u);
		await assert.rejects(execute(failingRead, "missing.txt"), /remote path missing/u);
		for (const [path, selectorKind] of [
			["bundle.zip:src/a.txt", "archive"],
			["state.sqlite:events", "sqlite"],
			["analysis.ipynb", "notebook"],
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
		controlFs.armed = false;
	}

	assert.deepEqual(controlFs.calls, []);
	assert.deepEqual(paths, ["/work/src/a.txt", "/work/missing.txt"]);
});
