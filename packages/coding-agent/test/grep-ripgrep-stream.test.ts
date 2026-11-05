import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { ChildProcess, spawn } from "child_process";
import { beforeEach, describe, it, vi } from "vitest";
import { createGrepTool, type GrepToolInput } from "../src/core/tools/grep.js";
import { DEFAULT_MAX_BYTES, truncateHead } from "../src/core/tools/truncate.js";

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	spawn: vi.fn(),
}));

vi.mock("../src/utils/tools-manager.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/tools-manager.js")>()),
	ensureTool: vi.fn(async () => "rg"),
}));

vi.mock("../src/core/tools/truncate.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/truncate.js")>();
	return { ...actual, truncateHead: vi.fn(actual.truncateHead) };
});

type RgEvent = object | string;

interface RgRun {
	args: string[];
	kills: number;
	eventsDeliveredAtKill: number | undefined;
}

function lineEvent(type: "match" | "context", path: string, lineNumber: number, line: string) {
	return { type, data: { path: { text: path }, line_number: lineNumber, lines: { text: `${line}\n` } } };
}

const matchEvent = (path: string, lineNumber: number, line: string) => lineEvent("match", path, lineNumber, line);
const contextEvent = (path: string, lineNumber: number, line: string) => lineEvent("context", path, lineNumber, line);

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

/**
 * Runs the ripgrep path of the grep tool against a scripted ripgrep process. Each event is delivered as its own
 * stdout chunk; a kill request is recorded together with how many events had been delivered, and the process then
 * closes like a killed child (code null) while the remaining events are still delivered.
 */
async function runRipgrep(events: RgEvent[], input: Omit<GrepToolInput, "pattern"> = {}) {
	const run: RgRun = { args: [], kills: 0, eventsDeliveredAtKill: undefined };
	let delivered = 0;
	let deliveryError: Error | undefined;

	vi.mocked(spawn).mockImplementationOnce((_command, args) => {
		run.args = [...args];
		const child = new ChildProcess();
		const stdout = new PassThrough();
		child.stdout = stdout;
		child.stderr = new PassThrough();
		let closed = false;
		const close = (code: number | null) => {
			if (closed) return;
			closed = true;
			child.emit("close", code, null);
		};
		vi.spyOn(child, "kill").mockImplementation(() => {
			run.kills++;
			run.eventsDeliveredAtKill ??= delivered;
			Object.assign(child, { killed: true });
			setImmediate(() => close(null));
			return true;
		});
		setImmediate(() => {
			try {
				for (const event of events) {
					delivered++;
					stdout.emit("data", Buffer.from(`${typeof event === "string" ? event : JSON.stringify(event)}\n`));
				}
				stdout.emit("end");
			} catch (error) {
				deliveryError = error instanceof Error ? error : new Error(String(error));
			}
			setImmediate(() => close(0));
		});
		return child;
	});

	const tool = createGrepTool(process.cwd(), { operations: { isDirectory: () => true } });
	const result = await tool.execute("rg-stream", { pattern: "needle", ...input });
	if (deliveryError) throw deliveryError;
	return { result, run, output: textOf(result) };
}

function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

describe("grep ripgrep JSON stream handling", () => {
	beforeEach(() => {
		vi.mocked(spawn).mockReset();
		vi.mocked(truncateHead).mockClear();
	});

	it("ignores output lines that are not JSON objects", async () => {
		const { output } = await runRipgrep(
			["null", "5", '"text"', "[]", "", "   ", "{", matchEvent("a.txt", 1, "needle")],
			{ contextBefore: 1 },
		);

		assert.equal(output, "a.txt:1: needle");
	});

	it("ignores events that are not match or context lines or that lack a path or line number", async () => {
		const { output } = await runRipgrep(
			[
				{ type: "begin", data: { path: { text: "a.txt" }, line_number: 1, lines: { text: "begin\n" } } },
				{ type: "end", data: { path: { text: "a.txt" }, line_number: 1, lines: { text: "end\n" } } },
				{ type: "match" },
				{ type: "match", data: { line_number: 9, lines: { text: "no path\n" } } },
				{ type: "match", data: { path: {}, line_number: 9, lines: { text: "empty path\n" } } },
				{ type: "match", data: { path: { text: "a.txt" }, lines: { text: "no line number\n" } } },
				{ type: "match", data: { path: { text: "a.txt" }, line_number: "9", lines: { text: "text number\n" } } },
				matchEvent("a.txt", 2, "needle"),
			],
			{ contextBefore: 2 },
		);

		assert.equal(output, "a.txt:2: needle");
	});

	it("decodes paths and lines delivered as base64 bytes", async () => {
		const bytes = (value: string) => ({ bytes: Buffer.from(value, "utf-8").toString("base64") });
		const { output } = await runRipgrep([
			{ type: "match", data: { path: bytes("caf\u00e9.txt"), line_number: 4, lines: bytes("needle \u00e9\n") } },
		]);

		assert.equal(output, "caf\u00e9.txt:4: needle \u00e9");
	});

	it("keeps newlines inside a multi-line match and strips only the terminator", async () => {
		const { output } = await runRipgrep([
			{ type: "match", data: { path: { text: "a.txt" }, line_number: 1, lines: { text: "first\r\nsecond\r\n" } } },
		]);

		assert.equal(output, "a.txt:1: first\nsecond");
	});

	it("counts every match in count mode without applying the limit or context events", async () => {
		const { output, result, run } = await runRipgrep(
			[
				matchEvent("a.txt", 1, "one"),
				contextEvent("a.txt", 2, "two"),
				matchEvent("a.txt", 3, "three"),
				matchEvent("b.txt", 1, "four"),
			],
			{ mode: "count", limit: 1, context: 2 },
		);

		assert.equal(output, "3");
		assert.equal(result.details, undefined);
		assert.equal(run.kills, 0);
	});

	it("lists each file once in filesWithMatches mode and ignores context events", async () => {
		const events = [
			matchEvent("a.txt", 1, "one"),
			matchEvent("a.txt", 3, "two"),
			contextEvent("c.txt", 1, "context only"),
			matchEvent("b.txt", 1, "three"),
		];

		const { output, result } = await runRipgrep(events, { mode: "filesWithMatches", context: 2 });

		assert.equal(output, "a.txt\nb.txt");
		assert.equal(result.details, undefined);
	});

	for (const offset of [undefined, 1]) {
		it(`skips the first files in filesWithMatches mode (offset: ${offset})`, async () => {
			const { output } = await runRipgrep(
				[
					matchEvent("a.txt", 1, "one"),
					matchEvent("a.txt", 3, "two"),
					matchEvent("b.txt", 1, "three"),
					matchEvent("c.txt", 1, "four"),
				],
				{ mode: "filesWithMatches", offset },
			);

			assert.equal(output, offset === undefined ? "a.txt\nb.txt\nc.txt" : "b.txt\nc.txt");
		});
	}

	it("stops at the file limit in filesWithMatches mode and ignores later events", async () => {
		const { output, result, run } = await runRipgrep(
			[
				matchEvent("a.txt", 1, "one"),
				matchEvent("b.txt", 1, "two"),
				matchEvent("c.txt", 1, "three"),
				matchEvent("d.txt", 1, "four"),
			],
			{ mode: "filesWithMatches", limit: 2 },
		);

		assert.equal(output, "a.txt\nb.txt");
		assert.deepEqual(result.details, { matchLimitReached: 2 });
		assert.equal(run.kills, 1);
		assert.equal(run.eventsDeliveredAtKill, 2);
	});

	it("stops after the trailing context of the last allowed match and ignores later events", async () => {
		const { output, result, run } = await runRipgrep(
			[
				matchEvent("f.txt", 2, "one"),
				matchEvent("f.txt", 3, "two"),
				contextEvent("f.txt", 4, "three"),
				contextEvent("f.txt", 4, "late duplicate"),
			],
			{ limit: 1, contextAfter: 2 },
		);

		assert.equal(output.split("\n\n")[0], ["f.txt:2: one", "f.txt-3- two", "f.txt-4- three"].join("\n"));
		assert.equal(result.details?.matchLimitReached, 1);
		assert.equal(run.kills, 1);
		assert.equal(run.eventsDeliveredAtKill, 3);
	});

	it("stops as soon as a match outside the trailing context proves the limit cut results off", async () => {
		const { output, result, run } = await runRipgrep(
			[matchEvent("f.txt", 2, "one"), matchEvent("f.txt", 5, "two"), matchEvent("f.txt", 6, "three")],
			{ limit: 1 },
		);

		assert.equal(output.split("\n\n")[0], "f.txt:2: one");
		assert.equal(result.details?.matchLimitReached, 1);
		assert.equal(run.kills, 1);
		assert.equal(run.eventsDeliveredAtKill, 2);
	});

	it("does not report the limit when no further match arrives after the last allowed one", async () => {
		const { output, result, run } = await runRipgrep(
			[matchEvent("f.txt", 2, "one"), contextEvent("f.txt", 3, "after")],
			{
				limit: 1,
				contextAfter: 1,
			},
		);

		assert.equal(output, ["f.txt:2: one", "f.txt-3- after"].join("\n"));
		assert.equal(result.details, undefined);
		assert.equal(run.kills, 0);
	});

	it("drops pending context from another file when a later match shows its leading context", async () => {
		const { output } = await runRipgrep(
			[
				matchEvent("a.txt", 1, "one"),
				contextEvent("a.txt", 2, "after one"),
				contextEvent("b.txt", 2, "before two"),
				matchEvent("b.txt", 3, "two"),
			],
			{ offset: 1, contextBefore: 1, contextAfter: 1 },
		);

		assert.equal(output, ["b.txt-2- before two", "b.txt:3: two"].join("\n"));
	});

	it("keeps skipped adjacent matches as leading context (#4361)", async () => {
		const { output } = await runRipgrep([matchEvent("a.txt", 1, "needle A"), matchEvent("a.txt", 2, "needle B")], {
			literal: true,
			offset: 1,
			contextBefore: 1,
		});

		assert.equal(output, "a.txt-1- needle A\na.txt:2: needle B");
	});

	it("keeps the requested leading window across skipped matches (#4361)", async () => {
		const { output } = await runRipgrep(
			[
				contextEvent("a.txt", 1, "outside"),
				contextEvent("a.txt", 2, "before"),
				matchEvent("a.txt", 3, "needle A"),
				matchEvent("a.txt", 4, "needle B"),
				matchEvent("a.txt", 5, "needle C"),
			],
			{ literal: true, offset: 2, contextBefore: 3 },
		);

		assert.equal(output, "a.txt-2- before\na.txt-3- needle A\na.txt-4- needle B\na.txt:5: needle C");
	});

	it("does not show skipped matches without leading context (#4361)", async () => {
		const { output } = await runRipgrep([matchEvent("a.txt", 1, "needle A"), matchEvent("a.txt", 2, "needle B")], {
			literal: true,
			offset: 1,
		});

		assert.equal(output, "a.txt:2: needle B");
	});

	it("does not carry skipped matches across a gap in the leading window (#4361)", async () => {
		const { output } = await runRipgrep(
			[matchEvent("a.txt", 1, "needle A"), contextEvent("a.txt", 4, "before"), matchEvent("a.txt", 5, "needle B")],
			{ literal: true, offset: 1, contextBefore: 1 },
		);

		assert.equal(output, "a.txt-4- before\na.txt:5: needle B");
	});

	for (const nextFile of ["a.txt", "b.txt"]) {
		it(`drops stale skipped context when the next match is in ${nextFile} without context events (#4361)`, async () => {
			const nextLine = nextFile === "a.txt" ? 5 : 2;
			const { output } = await runRipgrep(
				[matchEvent("a.txt", 1, "needle A"), matchEvent(nextFile, nextLine, "needle B")],
				{ literal: true, offset: 1, contextBefore: 1 },
			);

			assert.equal(output, `${nextFile}:${nextLine}: needle B`);
		});
	}

	for (const sameFile of [true, false]) {
		it(`bounds leading-context work across skipped matches (same file: ${sameFile}) (#4361)`, async () => {
			const contextBefore = 3;
			const skippedMatches = 100;
			let largestContextFilter = 0;
			const originalFilter = Array.prototype.filter;
			const filter = vi.spyOn(Array.prototype, "filter").mockImplementation(function (
				this: Array<{ lineText?: string }>,
				predicate,
				thisArg,
			) {
				if (this[0]?.lineText?.startsWith("retained needle")) {
					largestContextFilter = Math.max(largestContextFilter, this.length);
				}
				return originalFilter.call(this, predicate, thisArg);
			});
			try {
				const fileAt = (index: number) => (sameFile ? "a.txt" : `file${index}.txt`);
				const lineAt = (index: number) => (sameFile ? index + 1 : skippedMatches);
				const events = Array.from({ length: skippedMatches }, (_, index) =>
					matchEvent(fileAt(index), lineAt(index), `retained needle ${index}`),
				);
				const lastFile = fileAt(skippedMatches - 1);
				events.push(matchEvent(lastFile, skippedMatches + 1, "selected needle"));
				const { output } = await runRipgrep(events, { literal: true, offset: skippedMatches, contextBefore });
				const contextIndices = sameFile ? [97, 98, 99] : [99];
				const expected = contextIndices.map(
					(index) => `${fileAt(index)}-${lineAt(index)}- retained needle ${index}`,
				);
				expected.push(`${lastFile}:101: selected needle`);
				assert.equal(output, expected.join("\n"));
				assert.ok(
					largestContextFilter <= contextBefore + 1,
					`context filter visited ${largestContextFilter} lines`,
				);
			} finally {
				filter.mockRestore();
			}
		});
	}

	it("keeps counting lines past the byte cap without handing them to truncation", async () => {
		const body = "x".repeat(400);
		const events = Array.from({ length: 1000 }, (_, index) => matchEvent("f.txt", index + 1, body));
		const fullOutput = events.map((_, index) => `f.txt:${index + 1}: ${body}`).join("\n");

		const { result } = await runRipgrep(events, { limit: 1000 });

		const handedToTruncation = vi.mocked(truncateHead).mock.calls[0][0];
		assert.ok(handedToTruncation.length > DEFAULT_MAX_BYTES);
		assert.ok(handedToTruncation.length <= DEFAULT_MAX_BYTES + 500);
		assert.equal(result.details?.truncation?.totalLines, 1000);
		assert.equal(result.details?.truncation?.totalBytes, Buffer.byteLength(fullOutput, "utf-8"));
	});

	describe("context flags", () => {
		const cases: Array<{
			name: string;
			input: Omit<GrepToolInput, "pattern">;
			before: string | undefined;
			after: string | undefined;
		}> = [
			{ name: "content mode without context", input: {}, before: undefined, after: undefined },
			{ name: "content mode with context", input: { context: 2 }, before: "2", after: "2" },
			{ name: "content mode with only contextBefore", input: { contextBefore: 3 }, before: "3", after: undefined },
			{ name: "content mode with only contextAfter", input: { contextAfter: 4 }, before: undefined, after: "4" },
			{ name: "content mode with negative context", input: { context: -1 }, before: undefined, after: undefined },
			{ name: "count mode", input: { mode: "count", context: 2 }, before: undefined, after: undefined },
			{
				name: "filesWithMatches mode",
				input: { mode: "filesWithMatches", contextBefore: 2, contextAfter: 2 },
				before: undefined,
				after: undefined,
			},
		];

		for (const { name, input, before, after } of cases) {
			it(`passes ${name} to ripgrep as expected`, async () => {
				const { run } = await runRipgrep([matchEvent("a.txt", 1, "needle")], input);

				assert.equal(flagValue(run.args, "--before-context"), before);
				assert.equal(flagValue(run.args, "--after-context"), after);
			});
		}
	});
});
