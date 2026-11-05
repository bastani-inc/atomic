import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyReplacementsPreservingUnchangedLines } from "../src/core/tools/edit-diff.ts";
import {
	EditInputError,
	EditMatchError,
	EditTargetError,
	EditToolError,
	type EditToolErrorCode,
	FileToolAbortedError,
	isEditInputError,
	isEditMatchError,
	isEditTargetError,
	isEditToolError,
	isFileToolAbortedError,
	isWriteSelectorError,
	rehydrateEditToolError,
	rehydrateWriteSelectorError,
	serializeFileToolError,
	WriteSelectorError,
	type WriteSelectorErrorCode,
} from "../src/core/tools/file-tool-errors.ts";
import { createToolDefinition } from "../src/core/tools/index.ts";
import { createWriteTool, createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "file-tool-errors-"));
	tempDirs.push(dir);
	return dir;
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

async function editFailure(content: string, edits: Array<{ oldText: string; newText: string }>): Promise<unknown> {
	const dir = await tempDir();
	await writeFile(join(dir, "file.txt"), content);
	const failure = await caught(() => createEditTool(dir).execute("edit", { path: "file.txt", edits }));
	expect(await readFile(join(dir, "file.txt"), "utf8")).toBe(content);
	return failure;
}

describe("edit tool errors by code", () => {
	it("edits-empty: an empty edits array is an EditInputError", async () => {
		const failure = await editFailure("a\n", []);
		expect(isEditInputError(failure)).toBe(true);
		expect(failure).toBeInstanceOf(EditInputError);
		expect(failure).toMatchObject({
			name: "EditInputError",
			code: "edits-empty",
			retryable: false,
			fields: { path: "file.txt", totalEdits: 0 },
		});
		expect((failure as EditInputError).message).toBe(
			"Edit tool input is invalid. edits must contain at least one replacement.",
		);
		expect((failure as EditInputError).hint).toBe("Pass at least one { oldText, newText } replacement in edits.");
	});

	it("old-text-empty: names the empty edit's index", async () => {
		const failure = await editFailure("a\nb\n", [
			{ oldText: "a", newText: "A" },
			{ oldText: "", newText: "B" },
		]);
		expect(isEditInputError(failure)).toBe(true);
		expect(failure).toMatchObject({
			code: "old-text-empty",
			fields: { path: "file.txt", editIndex: 1, totalEdits: 2 },
		});
		expect((failure as Error).message).toBe("edits[1].oldText must not be empty in file.txt.");
	});

	it("text-not-found: a missing oldText is an EditMatchError", async () => {
		const failure = await editFailure("alpha\n", [{ oldText: "beta", newText: "gamma" }]);
		expect(isEditMatchError(failure)).toBe(true);
		expect(failure).toBeInstanceOf(EditMatchError);
		expect(failure).toMatchObject({
			name: "EditMatchError",
			code: "text-not-found",
			fields: { path: "file.txt", editIndex: 0, totalEdits: 1 },
		});
		expect((failure as Error).message).toBe(
			"Could not find the exact text in file.txt. The old text must match exactly including all whitespace and newlines.",
		);
	});

	it("text-not-unique: carries the occurrence count", async () => {
		const failure = await editFailure("x\nx\nx\ny\n", [
			{ oldText: "y", newText: "z" },
			{ oldText: "x", newText: "w" },
		]);
		expect(isEditMatchError(failure)).toBe(true);
		expect(failure).toMatchObject({
			code: "text-not-unique",
			fields: { path: "file.txt", editIndex: 1, totalEdits: 2, occurrences: 3 },
		});
		expect((failure as Error).message).toBe(
			"Found 3 occurrences of edits[1] in file.txt. Each oldText must be unique. Please provide more context to make it unique.",
		);
	});

	it("edits-overlap: names both overlapping edits", async () => {
		const failure = await editFailure("one\ntwo\nthree\n", [
			{ oldText: "two\nthree", newText: "2\n3" },
			{ oldText: "one\ntwo", newText: "1\n2" },
		]);
		expect(isEditMatchError(failure)).toBe(true);
		expect(failure).toMatchObject({
			code: "edits-overlap",
			fields: { path: "file.txt", editIndex: 0, overlapsEditIndex: 1, totalEdits: 2 },
		});
		expect((failure as Error).message).toBe(
			"edits[1] and edits[0] overlap in file.txt. Merge them into one edit or target disjoint regions.",
		);
	});

	it("no-change: identical replacements are an EditMatchError", async () => {
		const single = await editFailure("same\n", [{ oldText: "same", newText: "same" }]);
		expect(isEditMatchError(single)).toBe(true);
		expect(single).toMatchObject({ code: "no-change", fields: { path: "file.txt", totalEdits: 1 } });
		const multiple = await editFailure("a\nb\n", [
			{ oldText: "a", newText: "a" },
			{ oldText: "b", newText: "b" },
		]);
		expect(multiple).toMatchObject({ code: "no-change", fields: { totalEdits: 2 } });
		expect((multiple as Error).message).toBe(
			"No changes made to file.txt. The replacements produced identical content.",
		);
	});

	it("target-inaccessible: keeps the errno code and the filesystem error as cause", async () => {
		const dir = await tempDir();
		const failure = await caught(() =>
			createEditTool(dir).execute("edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }),
		);
		expect(isEditTargetError(failure)).toBe(true);
		expect(failure).toBeInstanceOf(EditTargetError);
		expect(failure).toMatchObject({
			name: "EditTargetError",
			code: "target-inaccessible",
			fields: { path: "missing.txt", errnoCode: "ENOENT" },
		});
		expect((failure as Error).message).toBe("Could not edit file: missing.txt. Error code: ENOENT.");
		expect((failure as Error).cause).toMatchObject({ code: "ENOENT" });
	});

	it("target-inaccessible: an access failure without an errno code carries no errnoCode", async () => {
		const offline = new Error("disk offline");
		const tool = createEditTool("/", {
			operations: {
				access: async () => {
					throw offline;
				},
				readFile: async () => Buffer.from("hello\n"),
				writeFile: async () => {},
			},
		});
		const failure = await caught(() =>
			tool.execute("edit", { path: "broken.txt", edits: [{ oldText: "hello", newText: "world" }] }),
		);
		expect(isEditTargetError(failure)).toBe(true);
		expect((failure as EditTargetError).fields).toStrictEqual({ path: "broken.txt" });
		expect((failure as Error).cause).toBe(offline);
	});

	it("every edit error belongs to the EditToolError family", async () => {
		const failure = await editFailure("a\n", [{ oldText: "missing", newText: "b" }]);
		expect(failure).toBeInstanceOf(EditToolError);
		expect(isEditToolError(failure)).toBe(true);
		expect(isEditInputError(failure)).toBe(false);
		expect(isEditTargetError(failure)).toBe(false);
		expect(isWriteSelectorError(failure)).toBe(false);
	});

	it("names the code for a single empty oldText, several missing edits and a single duplicate", async () => {
		const empty = await editFailure("a\n", [{ oldText: "", newText: "b" }]);
		expect(empty).toMatchObject({ code: "old-text-empty", fields: { editIndex: 0, totalEdits: 1 } });
		expect((empty as Error).message).toBe("oldText must not be empty in file.txt.");
		const missing = await editFailure("a\nb\n", [
			{ oldText: "a", newText: "A" },
			{ oldText: "zzz", newText: "Z" },
		]);
		expect(missing).toMatchObject({ code: "text-not-found", fields: { editIndex: 1, totalEdits: 2 } });
		expect((missing as Error).message).toBe(
			"Could not find edits[1] in file.txt. The oldText must match exactly including all whitespace and newlines.",
		);
		const duplicate = await editFailure("x x\n", [{ oldText: "x", newText: "y" }]);
		expect(duplicate).toMatchObject({
			code: "text-not-unique",
			fields: { editIndex: 0, totalEdits: 1, occurrences: 2 },
		});
		expect((duplicate as Error).message).toBe(
			"Found 2 occurrences of the text in file.txt. The text must be unique. Please provide more context to make it unique.",
		);
	});

	it("the family base class names itself", () => {
		const base = new EditToolError("no-change", "m", { path: "a" });
		expect(base.name).toBe("EditToolError");
		expect(base.hint).toBe("Make newText differ from oldText, or drop the edit.");
		expect(isEditToolError(base)).toBe(true);
	});
});

describe("cancellation", () => {
	it("an aborted edit throws FileToolAbortedError with the signal's reason as cause and writes nothing", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "file.txt"), "before\n");
		const controller = new AbortController();
		const reason = new Error("user pressed escape");
		controller.abort(reason);
		const failure = await caught(() =>
			createEditTool(dir).execute(
				"edit",
				{ path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
				controller.signal,
			),
		);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect(failure).toBeInstanceOf(FileToolAbortedError);
		expect(failure).toMatchObject({
			name: "AbortError",
			code: "aborted",
			retryable: false,
			message: "Operation aborted",
		});
		expect((failure as Error).cause).toBe(reason);
		expect(isEditToolError(failure)).toBe(false);
		expect(await readFile(join(dir, "file.txt"), "utf8")).toBe("before\n");
	});

	it("an aborted write throws FileToolAbortedError and creates nothing", async () => {
		const dir = await tempDir();
		const controller = new AbortController();
		controller.abort();
		const failure = await caught(() =>
			createWriteTool(dir).execute("write", { path: "new.txt", content: "x" }, controller.signal),
		);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect((failure as Error).cause).toBe(controller.signal.reason);
		await expect(readFile(join(dir, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("an abort without a reason carries no cause", () => {
		expect(new FileToolAbortedError().cause).toBeUndefined();
		expect("cause" in new FileToolAbortedError()).toBe(false);
	});
});

describe("write selector errors by code", () => {
	async function writeFailure(path: string, setup?: (dir: string) => Promise<void>): Promise<unknown> {
		const dir = await tempDir();
		await setup?.(dir);
		return caught(() =>
			createToolDefinition("write", dir).execute(
				"write",
				{ path, content: "resolution" },
				undefined,
				undefined,
				{} as ExtensionToolContext,
			),
		);
	}
	const conflictFile = async (dir: string) => {
		await writeFile(join(dir, "c.txt"), "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n");
	};
	const cases: Array<{
		code: WriteSelectorErrorCode;
		path: string;
		message: string;
		setup?: (dir: string) => Promise<void>;
		conflictId?: string;
	}> = [
		{
			code: "sqlite-query-parameters",
			path: "data.sqlite:users?limit=1",
			message: "SQLite write selectors must not include query parameters.",
		},
		{
			code: "sqlite-not-found",
			path: "data.sqlite:users",
			message: "SQLite database not found or is not SQLite: data.sqlite:users",
		},
		{ code: "conflict-target-required", path: "conflict://", message: "conflict:// target is required." },
		{
			code: "conflict-side-read-only",
			path: "conflict://1/ours",
			message: "Scoped conflict resources are read-only; write conflict://<id> or conflict://*.",
		},
		{ code: "conflict-markers-not-found", path: "conflict://1", message: "No conflict markers found." },
		{
			code: "conflict-target-invalid",
			path: "conflict://first",
			message: "Conflict writes must target conflict://<id> or conflict://*.",
			setup: conflictFile,
			conflictId: "first",
		},
		{
			code: "conflict-id-not-found",
			path: "conflict://9",
			message: "Conflict id not found: 9",
			setup: conflictFile,
			conflictId: "9",
		},
		{
			code: "unsupported-scheme",
			path: "https://example.com/file.txt",
			message: "Write resource selectors are not supported by this filesystem backend: https://example.com/file.txt",
		},
	];
	for (const { code, path, message, setup, conflictId } of cases) {
		it(`${code}`, async () => {
			const failure = await writeFailure(path, setup);
			expect(isWriteSelectorError(failure)).toBe(true);
			expect(failure).toBeInstanceOf(WriteSelectorError);
			expect(failure).toMatchObject({
				name: "WriteSelectorError",
				code,
				retryable: false,
				fields: { path, ...(conflictId ? { conflictId } : {}) },
			});
			expect((failure as Error).message).toBe(message);
			expect((failure as WriteSelectorError).hint.length).toBeGreaterThan(0);
			expect(isEditToolError(failure)).toBe(false);
		});
	}
});

describe("guards across realms", () => {
	it("recognise structural copies by name and code", () => {
		expect(isEditInputError({ name: "EditInputError", code: "edits-empty" })).toBe(true);
		expect(isEditMatchError({ name: "EditMatchError", code: "no-change" })).toBe(true);
		expect(isEditTargetError({ name: "EditTargetError", code: "target-inaccessible" })).toBe(true);
		expect(isEditToolError({ name: "EditToolError", code: "text-not-found" })).toBe(true);
		expect(isEditToolError({ name: "EditMatchError", code: "text-not-unique" })).toBe(true);
		expect(isWriteSelectorError({ name: "WriteSelectorError", code: "unsupported-scheme" })).toBe(true);
		expect(isFileToolAbortedError({ name: "AbortError", code: "aborted" })).toBe(true);
	});

	it("reject a name with a code from another class, and non-objects", () => {
		expect(isEditInputError({ name: "EditInputError", code: "no-change" })).toBe(false);
		expect(isEditMatchError({ name: "EditMatchError", code: "edits-empty" })).toBe(false);
		expect(isEditTargetError({ name: "EditTargetError", code: 7 })).toBe(false);
		expect(isEditToolError({ name: "EditToolError", code: "unsupported-scheme" })).toBe(false);
		expect(isWriteSelectorError({ name: "WriteSelectorError", code: "no-change" })).toBe(false);
		expect(isFileToolAbortedError({ name: "AbortError" })).toBe(false);
		expect(isEditMatchError({ name: "SomethingElse", code: "no-change" })).toBe(false);
		expect(isEditInputError({ name: "EditMatchError", code: "edits-empty" })).toBe(false);
		expect(isWriteSelectorError({ name: "EditMatchError", code: "unsupported-scheme" })).toBe(false);
		expect(isFileToolAbortedError({ name: "Error", code: "aborted" })).toBe(false);
		expect(isEditToolError(null)).toBe(false);
		expect(isEditToolError("EditMatchError")).toBe(false);
	});
});

describe("serialization round trip", () => {
	const editErrors: Array<() => EditToolError> = [
		() => new EditInputError("edits-empty", "no edits", { path: "a.txt", totalEdits: 0 }),
		() =>
			new EditMatchError("text-not-unique", "duplicate", {
				path: "a.txt",
				editIndex: 1,
				totalEdits: 2,
				occurrences: 4,
			}),
		() =>
			new EditTargetError(
				"target-inaccessible",
				"denied",
				{ path: "a.txt", errnoCode: "EACCES" },
				{ cause: Object.assign(new Error("EACCES: permission denied", { cause: "root" }), { code: "EACCES" }) },
			),
	];
	for (const make of editErrors) {
		const original = make();
		it(`${original.name} keeps its class, code, hint, fields and cause`, () => {
			const wire = JSON.parse(JSON.stringify(serializeFileToolError(original)));
			const restored = rehydrateEditToolError(wire);
			expect(restored).toBeInstanceOf(original.constructor);
			expect(isEditToolError(restored)).toBe(true);
			expect(restored).toMatchObject({
				name: original.name,
				code: original.code,
				message: original.message,
				hint: original.hint,
				fields: original.fields,
			});
			expect(serializeFileToolError(restored)).toEqual(wire);
		});
	}

	it("serializes a cause chain without stacks and rehydrates it as errors", () => {
		const original = editErrors[2]!();
		const wire = serializeFileToolError(original);
		expect(wire.cause).toEqual({
			name: "Error",
			message: "EACCES: permission denied",
			code: "EACCES",
			cause: { name: "Error", message: "root" },
		});
		const cause = rehydrateEditToolError(wire).cause as Error & { code?: string };
		expect(cause).toBeInstanceOf(Error);
		expect(cause.code).toBe("EACCES");
		expect((cause.cause as Error).message).toBe("root");
	});

	it("bounds a self-referential cause chain", () => {
		const loop = new Error("loop") as Error & { cause?: unknown };
		loop.cause = loop;
		const wire = serializeFileToolError(
			new EditTargetError("target-inaccessible", "x", { path: "a" }, { cause: loop }),
		);
		let depth = 0;
		for (let cause = wire.cause; cause; cause = cause.cause) depth++;
		expect(depth).toBe(4);
	});

	it("keeps WriteSelectorError identity", () => {
		const original = new WriteSelectorError("conflict-id-not-found", "Conflict id not found: 3", {
			path: "conflict://3",
			conflictId: "3",
		});
		const restored = rehydrateWriteSelectorError(JSON.parse(JSON.stringify(serializeFileToolError(original))));
		expect(restored).toBeInstanceOf(WriteSelectorError);
		expect(restored).toMatchObject({
			name: "WriteSelectorError",
			code: "conflict-id-not-found",
			fields: original.fields,
		});
		expect(restored.hint).toBe(original.hint);
	});

	it("rehydrates an unknown name or code into the family base, keeping name, code and hint", () => {
		const restored = rehydrateEditToolError({
			name: "EditQuotaError",
			code: "quota-exceeded",
			message: "too many edits",
			hint: "Split the edit.",
			fields: { path: "a.txt" },
		});
		expect(restored).toBeInstanceOf(EditToolError);
		expect(restored.constructor).toBe(EditToolError);
		expect(restored).toMatchObject({
			name: "EditQuotaError",
			code: "quota-exceeded" as EditToolErrorCode,
			hint: "Split the edit.",
		});
		const mismatched = rehydrateEditToolError({
			name: "EditMatchError",
			code: "edits-empty",
			message: "m",
			hint: "h",
			fields: { path: "a" },
		});
		expect(mismatched.constructor).toBe(EditToolError);
		expect(mismatched.name).toBe("EditMatchError");
		const foreignSelector = rehydrateWriteSelectorError({
			name: "WriteRemoteError",
			code: "remote-offline",
			message: "m",
			hint: "Reconnect.",
			fields: { path: "x" },
		});
		expect(foreignSelector).toMatchObject({ name: "WriteRemoteError", code: "remote-offline", hint: "Reconnect." });
		expect(isEditToolError(restored)).toBe(true);
	});

	it("only rebuilds a subclass when the name and the code both belong to it", () => {
		for (const [name, code] of [
			["EditTargetError", "no-change"],
			["EditInputError", "target-inaccessible"],
			["EditMatchError", "target-inaccessible"],
			["Unknown", "target-inaccessible"],
			["Unknown", "no-change"],
			["Unknown", "edits-empty"],
		] as const) {
			const restored = rehydrateEditToolError({ name, code, message: "m", hint: "h", fields: { path: "a" } });
			expect(restored.constructor, `${name}/${code}`).toBe(EditToolError);
			expect(restored.name).toBe(name);
		}
	});

	it("keeps a cause without a code free of a code key", () => {
		const original = new EditTargetError("target-inaccessible", "m", { path: "a" }, { cause: new Error("plain") });
		const wire = serializeFileToolError(original);
		expect(wire.cause).toStrictEqual({ name: "Error", message: "plain" });
		const cause = rehydrateEditToolError(wire).cause as Error;
		expect("code" in cause).toBe(false);
		expect(cause.cause).toBeUndefined();
	});
});

describe("edit-diff invariants", () => {
	it("refuses to preserve lines when the normalized base has a different line count", () => {
		expect(() =>
			applyReplacementsPreservingUnchangedLines("a\nb\n", "a\n", [{ matchIndex: 0, matchLength: 1, newText: "x" }]),
		).toThrow("Cannot preserve unchanged lines because the base content has a different line count.");
	});

	it("refuses a replacement outside the base content", () => {
		expect(() =>
			applyReplacementsPreservingUnchangedLines("a\n", "a\n", [{ matchIndex: 5, matchLength: 1, newText: "x" }]),
		).toThrow("Replacement range is outside the base content.");
		expect(() =>
			applyReplacementsPreservingUnchangedLines("a\n", "a\n", [{ matchIndex: 0, matchLength: 9, newText: "x" }]),
		).toThrow("Replacement range is outside the base content.");
		expect(() =>
			applyReplacementsPreservingUnchangedLines("a\nb\n", "a\nb\n", [
				{ matchIndex: -5, matchLength: 1, newText: "x" },
			]),
		).toThrow("Replacement range is outside the base content.");
	});
});

describe("Atomic adaptations of pi's edit and write", () => {
	it("keep same-message ordering exclusive", () => {
		expect(createEditToolDefinition("/").concurrency).toBe("exclusive");
		expect(createWriteToolDefinition("/").concurrency).toBe("exclusive");
	});
});
