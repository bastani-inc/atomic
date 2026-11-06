import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { MAX_SERIALIZED_CAUSE_DEPTH } from "../src/core/error-contract.js";
import type { ExtensionToolContext } from "../src/core/extensions/types.js";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.js";
import { widenReplacementsToLines } from "../src/core/tools/edit-diff.js";
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
	type SerializedErrorCause,
	serializeFileToolError,
	WriteSelectorError,
	type WriteSelectorErrorCode,
} from "../src/core/tools/file-tool-errors.js";
import { createToolDefinition } from "../src/core/tools/index.js";
import { createWriteTool, createWriteToolDefinition } from "../src/core/tools/write.js";
import type { SerializedErrorCause as RootSerializedErrorCause } from "../src/index.js";

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
	assert.equal(await readFile(join(dir, "file.txt"), "utf8"), content);
	return failure;
}

describe("edit tool errors by code", () => {
	it("edits-empty: an empty edits array is an EditInputError", async () => {
		const failure = await editFailure("a\n", []);
		assert.equal(isEditInputError(failure), true);
		assert.ok(failure instanceof EditInputError);
		assert.partialDeepStrictEqual(
			{ ...(failure as object) },
			{
				name: "EditInputError",
				code: "edits-empty",
				retryable: false,
				fields: { path: "file.txt", totalEdits: 0 },
			},
		);
		assert.equal(
			(failure as EditInputError).message,
			"Edit tool input is invalid. edits must contain at least one replacement.",
		);
		assert.equal((failure as EditInputError).hint, "Pass at least one { oldText, newText } replacement in edits.");
	});

	it("old-text-empty: names the empty edit's index", async () => {
		const failure = await editFailure("a\nb\n", [
			{ oldText: "a", newText: "A" },
			{ oldText: "", newText: "B" },
		]);
		assert.equal(isEditInputError(failure), true);
		assert.partialDeepStrictEqual(
			{ ...(failure as object) },
			{
				code: "old-text-empty",
				fields: { path: "file.txt", editIndex: 1, totalEdits: 2 },
			},
		);
		assert.equal((failure as Error).message, "edits[1].oldText must not be empty in file.txt.");
	});

	it("text-not-found: a missing oldText is an EditMatchError", async () => {
		const failure = await editFailure("alpha\n", [{ oldText: "beta", newText: "gamma" }]);
		assert.equal(isEditMatchError(failure), true);
		assert.ok(failure instanceof EditMatchError);
		assert.partialDeepStrictEqual(
			{ ...(failure as object) },
			{
				name: "EditMatchError",
				code: "text-not-found",
				fields: { path: "file.txt", editIndex: 0, totalEdits: 1 },
			},
		);
		assert.equal(
			(failure as Error).message,
			"Could not find the exact text in file.txt. The old text must match exactly including all whitespace and newlines.",
		);
	});

	it("text-not-unique: carries the occurrence count", async () => {
		const failure = await editFailure("x\nx\nx\ny\n", [
			{ oldText: "y", newText: "z" },
			{ oldText: "x", newText: "w" },
		]);
		assert.equal(isEditMatchError(failure), true);
		assert.partialDeepStrictEqual(
			{ ...(failure as object) },
			{
				code: "text-not-unique",
				fields: { path: "file.txt", editIndex: 1, totalEdits: 2, occurrences: 3 },
			},
		);
		assert.equal(
			(failure as Error).message,
			"Found 3 occurrences of edits[1] in file.txt. Each oldText must be unique. Please provide more context to make it unique.",
		);
	});

	it("edits-overlap: names both overlapping edits", async () => {
		const failure = await editFailure("one\ntwo\nthree\n", [
			{ oldText: "two\nthree", newText: "2\n3" },
			{ oldText: "one\ntwo", newText: "1\n2" },
		]);
		assert.equal(isEditMatchError(failure), true);
		assert.partialDeepStrictEqual(
			{ ...(failure as object) },
			{
				code: "edits-overlap",
				fields: { path: "file.txt", editIndex: 0, overlapsEditIndex: 1, totalEdits: 2 },
			},
		);
		assert.equal(
			(failure as Error).message,
			"edits[1] and edits[0] overlap in file.txt. Merge them into one edit or target disjoint regions.",
		);
	});

	it("no-change: identical replacements are an EditMatchError", async () => {
		const single = await editFailure("same\n", [{ oldText: "same", newText: "same" }]);
		assert.equal(isEditMatchError(single), true);
		assert.partialDeepStrictEqual(
			{ ...(single as object) },
			{ code: "no-change", fields: { path: "file.txt", totalEdits: 1 } },
		);
		const multiple = await editFailure("a\nb\n", [
			{ oldText: "a", newText: "a" },
			{ oldText: "b", newText: "b" },
		]);
		assert.partialDeepStrictEqual({ ...(multiple as object) }, { code: "no-change", fields: { totalEdits: 2 } });
		assert.equal(
			(multiple as Error).message,
			"No changes made to file.txt. The replacements produced identical content.",
		);
	});

	it("target-inaccessible: keeps the errno code and the filesystem error as cause", async () => {
		const dir = await tempDir();
		const failure = await caught(() =>
			createEditTool(dir).execute("edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }),
		);
		assert.equal(isEditTargetError(failure), true);
		assert.ok(failure instanceof EditTargetError);
		assert.partialDeepStrictEqual(
			{ ...(failure as object) },
			{
				name: "EditTargetError",
				code: "target-inaccessible",
				fields: { path: "missing.txt", errnoCode: "ENOENT" },
			},
		);
		assert.equal((failure as Error).message, "Could not edit file: missing.txt. Error code: ENOENT.");
		assert.partialDeepStrictEqual({ ...((failure as Error).cause as object) }, { code: "ENOENT" });
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
		assert.equal(isEditTargetError(failure), true);
		assert.deepEqual((failure as EditTargetError).fields, { path: "broken.txt" });
		assert.equal((failure as Error).cause, offline);
	});

	it("every edit error belongs to the EditToolError family", async () => {
		const failure = await editFailure("a\n", [{ oldText: "missing", newText: "b" }]);
		assert.ok(failure instanceof EditToolError);
		assert.equal(isEditToolError(failure), true);
		assert.equal(isEditInputError(failure), false);
		assert.equal(isEditTargetError(failure), false);
		assert.equal(isWriteSelectorError(failure), false);
	});

	it("names the code for a single empty oldText, several missing edits and a single duplicate", async () => {
		const empty = await editFailure("a\n", [{ oldText: "", newText: "b" }]);
		assert.partialDeepStrictEqual(
			{ ...(empty as object) },
			{ code: "old-text-empty", fields: { editIndex: 0, totalEdits: 1 } },
		);
		assert.equal((empty as Error).message, "oldText must not be empty in file.txt.");
		const missing = await editFailure("a\nb\n", [
			{ oldText: "a", newText: "A" },
			{ oldText: "zzz", newText: "Z" },
		]);
		assert.partialDeepStrictEqual(
			{ ...(missing as object) },
			{ code: "text-not-found", fields: { editIndex: 1, totalEdits: 2 } },
		);
		assert.equal(
			(missing as Error).message,
			"Could not find edits[1] in file.txt. The oldText must match exactly including all whitespace and newlines.",
		);
		const duplicate = await editFailure("x x\n", [{ oldText: "x", newText: "y" }]);
		assert.partialDeepStrictEqual(
			{ ...(duplicate as object) },
			{
				code: "text-not-unique",
				fields: { editIndex: 0, totalEdits: 1, occurrences: 2 },
			},
		);
		assert.equal(
			(duplicate as Error).message,
			"Found 2 occurrences of the text in file.txt. The text must be unique. Please provide more context to make it unique.",
		);
	});

	it("the family base class names itself", () => {
		const base = new EditToolError("no-change", "m", { path: "a" });
		assert.equal(base.name, "EditToolError");
		assert.equal(base.hint, "Make newText differ from oldText, or drop the edit.");
		assert.equal(isEditToolError(base), true);
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
		assert.equal(isFileToolAbortedError(failure), true);
		assert.ok(failure instanceof FileToolAbortedError);
		assert.equal(failure.name, "AbortError");
		assert.equal(failure.code, "aborted");
		assert.equal(failure.retryable, false);
		assert.equal(failure.message, "Operation aborted");
		assert.equal(failure.cause, reason);
		assert.equal(isEditToolError(failure), false);
		assert.equal(await readFile(join(dir, "file.txt"), "utf8"), "before\n");
	});

	it("an aborted write throws FileToolAbortedError and creates nothing", async () => {
		const dir = await tempDir();
		const controller = new AbortController();
		controller.abort();
		const failure = await caught(() =>
			createWriteTool(dir).execute("write", { path: "new.txt", content: "x" }, controller.signal),
		);
		assert.equal(isFileToolAbortedError(failure), true);
		assert.equal((failure as Error).cause, controller.signal.reason);
		await assert.rejects(readFile(join(dir, "new.txt"), "utf8"), (error: unknown) => {
			assert.partialDeepStrictEqual({ ...(error as object) }, { code: "ENOENT" });
			return true;
		});
	});

	it("an abort without a reason carries no cause", () => {
		assert.equal(new FileToolAbortedError().cause, undefined);
		assert.equal("cause" in new FileToolAbortedError(), false);
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
			assert.equal(isWriteSelectorError(failure), true);
			assert.ok(failure instanceof WriteSelectorError);
			assert.partialDeepStrictEqual(
				{ ...(failure as object) },
				{
					name: "WriteSelectorError",
					code,
					retryable: false,
					fields: { path, ...(conflictId ? { conflictId } : {}) },
				},
			);
			assert.equal((failure as Error).message, message);
			assert.ok((failure as WriteSelectorError).hint.length > 0);
			assert.equal(isEditToolError(failure), false);
		});
	}
});

describe("guards across realms", () => {
	it("recognise structural copies by name and code", () => {
		assert.equal(isEditInputError({ name: "EditInputError", code: "edits-empty" }), true);
		assert.equal(isEditMatchError({ name: "EditMatchError", code: "no-change" }), true);
		assert.equal(isEditTargetError({ name: "EditTargetError", code: "target-inaccessible" }), true);
		assert.equal(isEditToolError({ name: "EditToolError", code: "text-not-found" }), true);
		assert.equal(isEditToolError({ name: "EditMatchError", code: "text-not-unique" }), true);
		assert.equal(isWriteSelectorError({ name: "WriteSelectorError", code: "unsupported-scheme" }), true);
		assert.equal(isFileToolAbortedError({ name: "AbortError", code: "aborted" }), true);
	});

	it("reject invalid codes and non-object values without throwing (#4328)", () => {
		assert.equal(isEditInputError({ name: "EditInputError", code: "no-change" }), false);
		assert.equal(isEditMatchError({ name: "EditMatchError", code: "edits-empty" }), false);
		assert.equal(isEditTargetError({ name: "EditTargetError", code: 7 }), false);
		assert.equal(isEditToolError({ name: "EditToolError", code: "unsupported-scheme" }), false);
		assert.equal(isWriteSelectorError({ name: "WriteSelectorError", code: "no-change" }), false);
		assert.equal(isFileToolAbortedError({ name: "AbortError" }), false);
		assert.equal(isEditMatchError({ name: "SomethingElse", code: "no-change" }), false);
		assert.equal(isEditInputError({ name: "EditMatchError", code: "edits-empty" }), false);
		assert.equal(isWriteSelectorError({ name: "EditMatchError", code: "unsupported-scheme" }), false);
		assert.equal(isFileToolAbortedError({ name: "Error", code: "aborted" }), false);
		const guards = [
			isEditToolError,
			isEditInputError,
			isEditMatchError,
			isEditTargetError,
			isWriteSelectorError,
			isFileToolAbortedError,
		];
		for (const value of [undefined, null, false, 0, "EditMatchError", Symbol("error")]) {
			for (const guard of guards) assert.equal(guard(value), false);
		}
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
			assert.ok(restored instanceof original.constructor);
			assert.equal(isEditToolError(restored), true);
			assert.equal(restored.name, original.name);
			assert.equal(restored.code, original.code);
			assert.equal(restored.message, original.message);
			assert.equal(restored.hint, original.hint);
			assert.deepEqual(restored.fields, original.fields);
			assert.deepEqual(serializeFileToolError(restored), wire);
		});
	}

	it("serializes a cause chain without stacks and rehydrates it as errors", () => {
		const original = editErrors[2]!();
		const wire = serializeFileToolError(original);
		assert.deepEqual(wire.cause, {
			name: "Error",
			message: "EACCES: permission denied",
			code: "EACCES",
			cause: { name: "Error", message: "root" },
		});
		const cause = rehydrateEditToolError(wire).cause as Error & { code?: string };
		assert.ok(cause instanceof Error);
		assert.equal(cause.code, "EACCES");
		assert.equal((cause.cause as Error).message, "root");
	});

	it("serializes a cause as the root public SerializedErrorCause", () => {
		const wire = serializeFileToolError(editErrors[2]!());
		const asRoot: RootSerializedErrorCause | undefined = wire.cause;
		const asFileTool: SerializedErrorCause | undefined = asRoot;
		assert.equal(asFileTool?.code, "EACCES");
	});

	it("removes URL credentials from a serialized cause message", () => {
		const cause = new Error("connect failed: https://user:secret@example.com/path");
		const wire = serializeFileToolError(new EditTargetError("target-inaccessible", "x", { path: "a" }, { cause }));
		assert.equal(wire.cause?.message, "connect failed: https://example.com/path");
		assert.equal(JSON.stringify(wire).includes("secret"), false);
	});

	it("serializes a null cause as no cause", () => {
		const wire = serializeFileToolError(
			new EditTargetError("target-inaccessible", "x", { path: "a" }, { cause: null }),
		);
		assert.equal("cause" in wire, false);
	});

	it("bounds a self-referential cause chain", () => {
		const loop = new Error("loop") as Error & { cause?: unknown };
		loop.cause = loop;
		const wire = serializeFileToolError(
			new EditTargetError("target-inaccessible", "x", { path: "a" }, { cause: loop }),
		);
		let depth = 0;
		for (let cause = wire.cause; cause; cause = cause.cause) depth++;
		assert.equal(depth, MAX_SERIALIZED_CAUSE_DEPTH);
	});

	it("keeps WriteSelectorError identity", () => {
		const original = new WriteSelectorError("conflict-id-not-found", "Conflict id not found: 3", {
			path: "conflict://3",
			conflictId: "3",
		});
		const restored = rehydrateWriteSelectorError(JSON.parse(JSON.stringify(serializeFileToolError(original))));
		assert.ok(restored instanceof WriteSelectorError);
		assert.partialDeepStrictEqual(
			{ ...(restored as object) },
			{
				name: "WriteSelectorError",
				code: "conflict-id-not-found",
				fields: original.fields,
			},
		);
		assert.equal(restored.hint, original.hint);
	});

	it("rehydrates an unknown name or code into the family base, keeping name, code and hint", () => {
		const restored = rehydrateEditToolError({
			name: "EditQuotaError",
			code: "quota-exceeded",
			message: "too many edits",
			hint: "Split the edit.",
			fields: { path: "a.txt" },
		});
		assert.ok(restored instanceof EditToolError);
		assert.equal(restored.constructor, EditToolError);
		assert.partialDeepStrictEqual(
			{ ...(restored as object) },
			{
				name: "EditQuotaError",
				code: "quota-exceeded" as EditToolErrorCode,
				hint: "Split the edit.",
			},
		);
		const mismatched = rehydrateEditToolError({
			name: "EditMatchError",
			code: "edits-empty",
			message: "m",
			hint: "h",
			fields: { path: "a" },
		});
		assert.equal(mismatched.constructor, EditToolError);
		assert.equal(mismatched.name, "EditMatchError");
		const foreignSelector = rehydrateWriteSelectorError({
			name: "WriteRemoteError",
			code: "remote-offline",
			message: "m",
			hint: "Reconnect.",
			fields: { path: "x" },
		});
		assert.partialDeepStrictEqual(
			{ ...(foreignSelector as object) },
			{ name: "WriteRemoteError", code: "remote-offline", hint: "Reconnect." },
		);
		assert.equal(isEditToolError(restored), true);
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
			assert.equal(restored.constructor, EditToolError);
			assert.equal(restored.name, name);
		}
	});

	it("keeps a cause without a code free of a code key", () => {
		const original = new EditTargetError("target-inaccessible", "m", { path: "a" }, { cause: new Error("plain") });
		const wire = serializeFileToolError(original);
		assert.deepEqual(wire.cause, { name: "Error", message: "plain" });
		const cause = rehydrateEditToolError(wire).cause as Error;
		assert.equal("code" in cause, false);
		assert.equal(cause.cause, undefined);
	});
});

describe("edit-diff invariants", () => {
	it("refuses to preserve lines when the normalized base has a different line count", () => {
		assert.throws(
			() => widenReplacementsToLines("a\nb\n", "a\n", [{ matchIndex: 0, matchLength: 1, newText: "x" }]),
			{ message: "Cannot preserve unchanged lines because the base content has a different line count." },
		);
	});

	it("refuses a replacement outside the base content", () => {
		assert.throws(() => widenReplacementsToLines("a\n", "a\n", [{ matchIndex: 5, matchLength: 1, newText: "x" }]), {
			message: "Replacement range is outside the base content.",
		});
		assert.throws(() => widenReplacementsToLines("a\n", "a\n", [{ matchIndex: 0, matchLength: 9, newText: "x" }]), {
			message: "Replacement range is outside the base content.",
		});
		assert.throws(
			() => widenReplacementsToLines("a\nb\n", "a\nb\n", [{ matchIndex: -5, matchLength: 1, newText: "x" }]),
			{ message: "Replacement range is outside the base content." },
		);
	});
});

describe("Atomic adaptations of pi's edit and write", () => {
	it("keep same-message ordering exclusive", () => {
		assert.equal(createEditToolDefinition("/").concurrency, "exclusive");
		assert.equal(createWriteToolDefinition("/").concurrency, "exclusive");
	});
});
