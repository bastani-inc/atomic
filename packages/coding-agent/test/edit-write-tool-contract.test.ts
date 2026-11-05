import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition, type EditOperations } from "../src/core/tools/edit.ts";
import { isEditMatchError, isEditTargetError, isFileToolAbortedError } from "../src/core/tools/file-tool-errors.ts";
import { createWriteToolDefinition, type WriteOperations } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "edit-write-contract-"));
	tempDirs.push(dir);
	return dir;
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

/** A signal that reports aborted from its `abortAtCheck`-th read of `aborted` onward. */
function signalAbortingAtCheck(abortAtCheck: number): AbortSignal {
	let checks = 0;
	const reason = new Error(`aborted at check ${abortAtCheck}`);
	return {
		get aborted() {
			checks += 1;
			return checks >= abortAtCheck;
		},
		reason,
	} as AbortSignal;
}

function recordingEditOperations(content: string, accessError?: Error) {
	const calls: string[] = [];
	const writes: string[] = [];
	const operations: EditOperations = {
		access: async () => {
			calls.push("access");
			if (accessError) throw accessError;
		},
		readFile: async () => {
			calls.push("readFile");
			return Buffer.from(content, "utf-8");
		},
		writeFile: async (_path, text) => {
			calls.push("writeFile");
			writes.push(text);
		},
	};
	return { calls, writes, operations };
}

const ctx = {} as ExtensionToolContext;
const replace = { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] };

describe("edit arguments preparation", () => {
	const prepare = (input: unknown) => createEditToolDefinition("/").prepareArguments!(input);

	it("wraps a single edit object, given directly or as a JSON string", () => {
		const edit = { oldText: "a", newText: "b" };
		expect(prepare({ path: "f", edits: edit })).toEqual({ path: "f", edits: [edit] });
		expect(prepare({ path: "f", edits: JSON.stringify(edit) })).toEqual({ path: "f", edits: [edit] });
	});

	it("leaves edits that are not a replacement or an array as given", () => {
		expect(prepare({ path: "f", edits: JSON.stringify("text") })).toEqual({ path: "f", edits: '"text"' });
		const partial = { oldText: "a", newText: 1 };
		expect(prepare({ path: "f", edits: JSON.stringify(partial) })).toEqual({
			path: "f",
			edits: JSON.stringify(partial),
		});
		expect(prepare({ path: "f", edits: { newText: "b" } })).toEqual({ path: "f", edits: { newText: "b" } });
		expect(prepare({ path: "f", edits: null })).toEqual({ path: "f", edits: null });
		expect(prepare({ path: "f", edits: ["a"] })).toEqual({ path: "f", edits: ["a"] });
	});

	it("folds top-level oldText/newText only when both are strings", () => {
		expect(prepare({ path: "f", oldText: "a" })).toEqual({ path: "f", oldText: "a" });
		expect(prepare({ path: "f", newText: "b" })).toEqual({ path: "f", newText: "b" });
		expect(prepare({ path: "f", edits: "not json", oldText: "a", newText: "b" })).toEqual({
			path: "f",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});
});

describe("edit and write definitions keep upstream metadata", () => {
	it("edit", () => {
		const definition = createEditToolDefinition("/");
		expect(definition.description).toBe(
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		);
		expect(definition.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		expect(definition.renderShell).toBe("self");
	});

	it("write", () => {
		const definition = createWriteToolDefinition("/");
		expect(definition.description).toBe(
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		);
		expect(definition.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
	});
});

describe("edit stops at each cancellation checkpoint", () => {
	it("does not touch the file when already aborted", async () => {
		const { calls, operations } = recordingEditOperations("old\n");
		const failure = await rejection(() =>
			createEditToolDefinition("/", { operations }).execute("e", replace, signalAbortingAtCheck(1), undefined, ctx),
		);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect(calls).toEqual([]);
	});

	it("reports cancellation rather than an inaccessible file when aborted during the access check", async () => {
		const { calls, operations } = recordingEditOperations(
			"old\n",
			Object.assign(new Error("gone"), { code: "ENOENT" }),
		);
		const failure = await rejection(() =>
			createEditToolDefinition("/", { operations }).execute("e", replace, signalAbortingAtCheck(2), undefined, ctx),
		);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect(isEditTargetError(failure)).toBe(false);
		expect(calls).toEqual(["access"]);
	});

	it("does not read after an abort during the access check", async () => {
		const { calls, operations } = recordingEditOperations("old\n");
		const failure = await rejection(() =>
			createEditToolDefinition("/", { operations }).execute("e", replace, signalAbortingAtCheck(2), undefined, ctx),
		);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect(calls).toEqual(["access"]);
	});

	it("reports cancellation before matching after an abort during the read", async () => {
		const { calls, operations } = recordingEditOperations("unrelated\n");
		const failure = await rejection(() =>
			createEditToolDefinition("/", { operations }).execute("e", replace, signalAbortingAtCheck(3), undefined, ctx),
		);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect(isEditMatchError(failure)).toBe(false);
		expect(calls).toEqual(["access", "readFile"]);
	});

	it("does not write after an abort while the edits were applied", async () => {
		const { calls, operations } = recordingEditOperations("old\n");
		const failure = await rejection(() =>
			createEditToolDefinition("/", { operations }).execute("e", replace, signalAbortingAtCheck(4), undefined, ctx),
		);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect(calls).toEqual(["access", "readFile"]);
	});

	it("reports cancellation after a write that completed while aborting", async () => {
		const { calls, writes, operations } = recordingEditOperations("old\n");
		const failure = await rejection(() =>
			createEditToolDefinition("/", { operations }).execute("e", replace, signalAbortingAtCheck(5), undefined, ctx),
		);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect(calls).toEqual(["access", "readFile", "writeFile"]);
		expect(writes).toEqual(["new\n"]);
	});

	it("reads once and writes once for a successful edit, and never writes a failed one", async () => {
		const success = recordingEditOperations("old\n");
		await createEditToolDefinition("/", { operations: success.operations }).execute(
			"e",
			replace,
			undefined,
			undefined,
			ctx,
		);
		expect(success.calls).toEqual(["access", "readFile", "writeFile"]);
		const failed = recordingEditOperations("other\n");
		await rejection(() =>
			createEditToolDefinition("/", { operations: failed.operations }).execute(
				"e",
				replace,
				undefined,
				undefined,
				ctx,
			),
		);
		expect(failed.calls).toEqual(["access", "readFile"]);
	});
});

describe("write stops at each cancellation checkpoint", () => {
	function recordingWriteOperations() {
		const calls: string[] = [];
		const operations: WriteOperations = {
			mkdir: async () => {
				calls.push("mkdir");
			},
			writeFile: async () => {
				calls.push("writeFile");
			},
		};
		return { calls, operations };
	}
	const args = { path: "dir/file.txt", content: "x" };

	for (const [check, expected] of [
		[1, []],
		[2, ["mkdir"]],
		[3, ["mkdir", "writeFile"]],
	] as const) {
		it(`aborting at check ${check} leaves ${expected.join(", ") || "nothing"} done`, async () => {
			const { calls, operations } = recordingWriteOperations();
			const failure = await rejection(() =>
				createWriteToolDefinition("/", { operations }).execute(
					"w",
					args,
					signalAbortingAtCheck(check),
					undefined,
					ctx,
				),
			);
			expect(isFileToolAbortedError(failure)).toBe(true);
			expect(calls).toEqual(expected);
		});
	}

	it("creates parent directories with the default operations", async () => {
		const dir = await tempDir();
		await createWriteToolDefinition(dir).execute(
			"w",
			{ path: "a/b/c.txt", content: "é\n" },
			undefined,
			undefined,
			ctx,
		);
		expect(await readFile(join(dir, "a/b/c.txt"), "utf8")).toBe("é\n");
		await writeFile(join(dir, "a/b/c.txt"), "changed");
		await createWriteToolDefinition(dir).execute(
			"w",
			{ path: "a/b/c.txt", content: "again" },
			undefined,
			undefined,
			ctx,
		);
		expect(await readFile(join(dir, "a/b/c.txt"), "utf8")).toBe("again");
	});
});
