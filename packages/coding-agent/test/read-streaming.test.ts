import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle, open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as util from "node:util";
import { afterAll, describe, it, vi } from "vitest";
import { isFileToolAbortedError } from "../src/core/tools/file-tool-errors.js";
import { createReadToolDefinition, type OversizedReadDetails, type ReadOperations } from "../src/core/tools/read.js";
import {
	readLocalFileChunks,
	selectReadLinesFromChunks,
	selectReadLinesFromList,
} from "../src/core/tools/read-line-stream.js";
import {
	formatSelectedLines,
	mergeReadRanges,
	type ReadLineRange,
	selectExactReadRanges,
	selectReadRanges,
	splitReadLineSelector,
} from "../src/core/tools/read-selectors.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../src/core/tools/truncate.js";

// Runs when the read tool decodes a chunk: the file is open and partly read, so a test can change it mid-read.
const decodeHook = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));
vi.mock("util", async (importOriginal) => {
	const actual = await importOriginal<typeof util>();
	class HookedTextDecoder extends actual.TextDecoder {
		override decode(...args: Parameters<util.TextDecoder["decode"]>): string {
			decodeHook.run?.();
			return super.decode(...args);
		}
	}
	return { ...actual, TextDecoder: HookedTextDecoder };
});

const MAX_CHARS = 50_000;

interface ReadResult {
	content: { type: string; text?: string }[];
	details: unknown;
	isError?: boolean;
	structuredContent?: unknown;
}

type ReadOutcome = ReadResult | { error: string };

function textResult(text: string, details: unknown): ReadResult {
	return { content: [{ type: "text", text }], details, structuredContent: text };
}

// The read tool's text path before it streamed (#4353), with the range selection and oversized-read message it used,
// kept as the reference the streaming path must match byte for byte.
function referenceSelectReadRanges(allLines: string[], ranges: ReadLineRange[] | undefined) {
	if (!ranges || ranges.length === 0) return undefined;
	const selectedLines: string[] = [];
	const lineNumbers: number[] = [];
	const merged: ReadLineRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const bounded = range.end !== undefined;
		if (range.start > allLines.length) continue;
		const requestedEnd = Math.min(range.end ?? allLines.length, allLines.length);
		if (requestedEnd < range.start) continue;
		const start = Math.max(1, range.start - (bounded ? 1 : 0));
		const end = Math.min(allLines.length, requestedEnd + (bounded ? 3 : 0));
		const previous = merged.at(-1);
		if (previous && start <= (previous.end ?? 0) + 1) previous.end = Math.max(previous.end ?? 0, end);
		else merged.push({ start, end });
	}
	for (const range of merged) {
		const end = Math.min(range.end ?? allLines.length, allLines.length);
		for (let line = range.start; line <= end; line++) {
			selectedLines.push(allLines[line - 1] ?? "");
			lineNumbers.push(line);
		}
	}
	return { selectedLines, firstLine: lineNumbers[0] ?? 1, lineNumbers };
}

function referenceSelectExactReadRanges(allLines: string[], ranges: ReadLineRange[] | undefined) {
	if (!ranges || ranges.length === 0) return undefined;
	const selectedLines: string[] = [],
		lineNumbers: number[] = [],
		merged: ReadLineRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		if (range.start > allLines.length) continue;
		const end = Math.min(range.end ?? allLines.length, allLines.length);
		const previous = merged.at(-1);
		if (previous && range.start <= (previous.end ?? 0) + 1) previous.end = Math.max(previous.end ?? 0, end);
		else merged.push({ start: range.start, end });
	}
	for (const range of merged)
		for (let line = range.start; line <= (range.end ?? allLines.length); line++) {
			selectedLines.push(allLines[line - 1] ?? "");
			lineNumbers.push(line);
		}
	return { selectedLines, firstLine: lineNumbers[0] ?? 1, lineNumbers };
}

function referenceOversizedMessage(details: OversizedReadDetails): string {
	const count = (value: number) => value.toLocaleString("en-US");
	const pathForExample = JSON.stringify(details.path);
	const shellPath = `'${details.path.replace(/'/g, `'\\''`)}'`;
	const header = [
		`File read blocked: requested selected range is too large (${count(details.chars)} chars; threshold: ${count(details.maxChars)} chars).`,
		`Path: ${details.path}`,
		"",
	];
	if (details.byteGuidance) {
		return [
			...header,
			"The selected content starts with a single oversized line, so line pagination is not useful. Read byte slices instead. Examples:",
			`- Inspect the start of line ${details.startLine}: sed -n '${details.startLine}p' ${shellPath} | head -c ${DEFAULT_MAX_BYTES}`,
			`- Inspect a later byte window: sed -n '${details.startLine}p' ${shellPath} | tail -c +${DEFAULT_MAX_BYTES + 1} | head -c ${DEFAULT_MAX_BYTES}`,
			`- Search for relevant text first: search({ "pattern": "functionName", "paths": ${pathForExample} })`,
		].join("\n");
	}
	return [
		...header,
		"Read only the needed context incrementally. Examples:",
		`- Search for relevant symbols first: search({ "pattern": "functionName", "paths": ${pathForExample} })`,
		`- Read a smaller line range: read({ "path": ${JSON.stringify(`${details.path}:${details.startLine}+200`)} })`,
		`- Read a targeted snippet around a match: read({ "path": ${JSON.stringify(`${details.path}:${Math.max(details.startLine, 120)}+80`)} })`,
	].join("\n");
}

function referenceRead(textContent: string, pathWithSelector: string, absolutePath: string): ReadResult {
	const selector = splitReadLineSelector(pathWithSelector);
	const { path: effectivePath, offset: effectiveOffset, ranges: effectiveRanges, raw: rawOutput } = selector;
	const lineTextContent = rawOutput ? textContent : textContent.replace(/\r\n/g, "\n");
	const sourceLines = lineTextContent.split("\n");
	let allLines = rawOutput || !lineTextContent.endsWith("\n") ? sourceLines : sourceLines.slice(0, -1);
	if (selector.conflicts) {
		const conflictLines: string[] = [];
		let inConflict = false;
		for (const line of allLines) {
			if (line.startsWith("<<<<<<<")) inConflict = true;
			if (inConflict) conflictLines.push(line);
			if (line.startsWith(">>>>>>>")) inConflict = false;
		}
		if (conflictLines.length === 0) return textResult("No conflict markers found", undefined);
		allLines = conflictLines;
	}
	const totalFileLines = allLines.length;
	const rangeSelection = (rawOutput ? referenceSelectExactReadRanges : referenceSelectReadRanges)(
		allLines,
		effectiveRanges,
	);
	const startLine = rangeSelection
		? rangeSelection.firstLine - 1
		: effectiveOffset
			? Math.max(0, effectiveOffset - 1)
			: 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length || (effectiveRanges && rangeSelection?.selectedLines.length === 0)) {
		const requested = effectiveRanges?.[0]?.start ?? startLineDisplay;
		return textResult(
			`Requested line ${requested} is beyond end of file (${allLines.length} lines total). Use ${effectivePath}:${Math.max(1, allLines.length)} to read the final line.`,
			undefined,
		);
	}
	const selectedLines = rangeSelection?.selectedLines ?? allLines.slice(startLine);
	const selectedContent = selectedLines.join("\n");
	const meta = { source: absolutePath, sourcePath: absolutePath };
	if (selectedContent.length > MAX_CHARS) {
		let trimmed = selectedLines.length;
		while (trimmed > 0 && selectedLines[trimmed - 1] === "") trimmed--;
		const firstLineBytes = Buffer.byteLength(allLines[startLine] ?? "", "utf-8");
		const oversizedRead: OversizedReadDetails = {
			blocked: true,
			path: absolutePath,
			chars: selectedContent.length,
			maxChars: MAX_CHARS,
			startLine: startLineDisplay,
			totalFileLines,
			firstLineBytes,
			byteGuidance: trimmed <= 1 || firstLineBytes > DEFAULT_MAX_BYTES,
		};
		return {
			content: [{ type: "text", text: referenceOversizedMessage(oversizedRead) }],
			details: { oversizedRead, meta },
			isError: true,
		};
	}
	const truncation = truncateHead(selectedContent);
	const shownLines = truncation.truncated ? truncation.outputLines : selectedLines.length;
	const shownLineNumbers = rangeSelection?.lineNumbers.slice(0, shownLines);
	const lastShownLine = shownLineNumbers?.at(-1) ?? startLine + shownLines;
	let outputText =
		shownLineNumbers && !rawOutput
			? formatSelectedLines(selectedLines.slice(0, shownLines), shownLineNumbers, totalFileLines)
			: truncation.content;
	let details: unknown = { meta };
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
		outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${effectivePath} | head -c ${DEFAULT_MAX_BYTES}]`;
		details = { truncation, meta: { ...meta, truncation } };
	} else if (truncation.truncated) {
		const nextOffset = lastShownLine + 1;
		outputText +=
			truncation.truncatedBy === "lines"
				? `\n\n[Showing lines ${startLineDisplay}-${lastShownLine} of ${totalFileLines}. Continue with path selector :${nextOffset}.]`
				: `\n\n[Showing lines ${startLineDisplay}-${lastShownLine} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Continue with path selector :${nextOffset}.]`;
		details = { truncation, meta: { ...meta, truncation } };
	} else if (!rawOutput && rangeSelection && lastShownLine < allLines.length) {
		const remaining = allLines.length - lastShownLine;
		outputText += `\n\n[${remaining} more lines in file. Continue with path selector :${lastShownLine + 1}.]`;
	}
	return textResult(outputText, details);
}

const TEMP_DIR = mkdtempSync(join(tmpdir(), "atomic-read-streaming-"));
const FILE_PATH = join(TEMP_DIR, "missing", "file.txt");

function referenceOutcome(text: string, selector: string, absolutePath = FILE_PATH): ReadOutcome {
	try {
		return referenceRead(text, `${absolutePath}${selector}`, absolutePath);
	} catch (error) {
		return { error: (error as Error).message };
	}
}

async function outcome(run: () => Promise<ReadResult>): Promise<ReadOutcome> {
	try {
		return await run();
	} catch (error) {
		return { error: (error as Error).message };
	}
}

/** Splits bytes into chunks of `size`, so characters, CRLF pairs and lines split at chunk ends. */
async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
	for (let position = 0; position < bytes.length; position += size) {
		yield bytes.subarray(position, position + size);
	}
}

function streamingOps(bytes: Uint8Array, chunkSize: number, readFileCalls = { count: 0 }): ReadOperations {
	return {
		readFile: async () => {
			readFileCalls.count++;
			return Buffer.from(bytes);
		},
		access: async () => {},
		createReadStream: () => chunked(bytes, chunkSize),
	};
}

function readWith(ops: ReadOperations, selector: string, path = FILE_PATH, signal?: AbortSignal): Promise<ReadOutcome> {
	const tool = createReadToolDefinition(TEMP_DIR, { operations: ops });
	return outcome(() => tool.execute("call", { path: `${path}${selector}` }, signal, undefined, undefined as never));
}

function assertSameOutcome(actual: ReadOutcome, expected: ReadOutcome, label: string): void {
	assert.deepStrictEqual(actual, expected, label);
	// Session files store results as JSON, so key order is part of the output too.
	assert.equal(JSON.stringify(actual), JSON.stringify(expected), label);
}

function lines(count: number, make: (i: number) => string): string {
	return Array.from({ length: count }, (_, i) => make(i)).join("\n");
}

const FIFTY_THOUSAND_CHARS = `${lines(500, () => "y".repeat(99))}y`;

// Inputs around the boundaries the selection, notices, truncation and the oversized-read block depend on.
const TEXT_CASES: Record<string, string> = {
	empty: "",
	"one newline": "\n",
	"two newlines": "\n\n",
	"no trailing newline": "alpha\nbeta\ngamma",
	"trailing newline": "alpha\nbeta\n",
	"seven lines": lines(7, (i) => `line ${i + 1}`),
	"trailing empty lines": "a\nb\n\n\n",
	CRLF: "alpha\r\nbeta\r\n\r\ngamma\r\n",
	"lone carriage returns": "a\rb\r\nc\r\r\n\r",
	// One-byte chunks split the multi-byte character after each CR, so the decoder returns an empty piece in between.
	"carriage returns before multi-byte characters": "a\r€\r😀\r\n\r",
	"multi-byte characters and UTF-8 byte order mark": "\uFEFFé€😀\nñ\u{10348}字\r\n😀😀😀",
	conflict: "pre\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\npost\n",
	"conflict with CRLF": "pre\r\n<<<<<<< ours\r\nleft\r\n=======\r\nright\r\n>>>>>>> theirs\r\npost\r\n",
	"3001 lines": lines(3001, (i) => `line ${i}`),
	// truncateHead drops a trailing empty line: the empty line at the line cap must not end the selection early.
	"3001 lines, an empty line and more": `${lines(3001, (i) => `line ${i}`)}\n\nmore`,
	"first line over 50KB within 50,000 chars": `${"é".repeat(DEFAULT_MAX_BYTES / 2 + 1)}\nsecond`,
	"line over 50,000 chars after short lines": `a\nb\n${"z".repeat(60 * 1024)}\nc`,
	// Formatted reads drop the final newline and stay at the limit; :raw keeps an empty last line and exceeds it.
	"exactly 50,000 chars and a final newline": `${FIFTY_THOUSAND_CHARS}\n`,
	"50,001 chars": `${FIFTY_THOUSAND_CHARS}y`,
	"multi-byte characters over 50KB": lines(700, (i) => `${i} ${"€😀".repeat(13)}`),
	"one long line and trailing empty lines": `${"q".repeat(MAX_CHARS + 1)}\n\n\n`,
	"two long lines": `${"q".repeat(30_000)}\n${"r".repeat(30_000)}`,
	"long multi-byte first line": `${"é".repeat(26_000)}\n${"s".repeat(30_000)}`,
	"first line of exactly 51,200 bytes and more": `${"é".repeat(DEFAULT_MAX_BYTES / 2)}\n${"s".repeat(30_000)}`,
	"one line of exactly 50,000 chars": "q".repeat(MAX_CHARS),
	"an empty line that reaches 50,000 chars": `${"q".repeat(MAX_CHARS - 1)}\n\n`,
};

/** Selectors around the line counts of `text`: as `:raw` counts lines, and as formatted reads count them. */
function selectorsFor(text: string): string[] {
	const rawCount = text.split("\n").length;
	const formattedCount = text.replace(/\r\n/g, "\n").endsWith("\n") ? rawCount - 1 : rawCount;
	const selectors = new Set([
		"",
		":1",
		":2",
		":3",
		":1-1",
		":2-3",
		":2+2",
		":L2-L3",
		":2..4",
		":3,1-2",
		":5,5-6",
		":5-6,5",
		":1-2,2-3",
		":1-2,3-4",
		":2-3,8-9",
		":2,4-5",
		":conflicts",
		":conflicts:2-3",
	]);
	for (const count of [rawCount, formattedCount]) {
		for (const selector of [
			`:${count}`,
			`:${count + 1}`,
			`:${count}-${count}`,
			`:${count + 1}-${count + 2}`,
			`:${count + 2}-${count + 3}`,
			`:1,${count + 1}-${count + 3}`,
			`:1-2,${count}-${count + 5}`,
		]) {
			selectors.add(selector);
		}
		if (count > 1) selectors.add(`:${count - 1}-${count}`);
	}
	return [...selectors].flatMap((selector) => [selector, `${selector}:raw`]);
}

afterAll(() => rmSync(TEMP_DIR, { recursive: true, force: true }));

describe("read tool streaming (#4353)", () => {
	it("gives the same output as the whole-file algorithm for every selector", async () => {
		for (const [name, text] of Object.entries(TEXT_CASES)) {
			const bytes = Buffer.from(text, "utf-8");
			const chunkSizes = bytes.length < 1024 ? [1, 3, 4096] : [4093, 65_536];
			for (const selector of selectorsFor(text)) {
				const expected = referenceOutcome(text, selector);
				const usesWholeText = selector.includes(":conflicts");
				for (const chunkSize of chunkSizes) {
					const readFileCalls = { count: 0 };
					const label = `${name}, ${JSON.stringify(selector)}, chunks of ${chunkSize}`;
					assertSameOutcome(
						await readWith(streamingOps(bytes, chunkSize, readFileCalls), selector),
						expected,
						label,
					);
					assert.equal(readFileCalls.count, usesWholeText ? 1 : 0, `${label}: readFile calls`);
				}
				const wholeFileOps: ReadOperations = { readFile: async () => bytes, access: async () => {} };
				assertSameOutcome(await readWith(wholeFileOps, selector), expected, `${name}, ${selector}, readFile`);
			}
		}
	});

	it("keeps details key order, which session files serialize", async () => {
		const text = TEXT_CASES["3001 lines"];
		const streamed = (await readWith(streamingOps(Buffer.from(text), 4096), "")) as ReadResult;
		const expected = referenceOutcome(text, "") as ReadResult;
		assert.equal(JSON.stringify(streamed.details), JSON.stringify(expected.details));
		assert.deepEqual(Object.keys(streamed.details as object), ["truncation", "meta"]);
	});

	it("decodes multi-byte characters split across chunks and invalid UTF-8 like Buffer.toString", async () => {
		const bytes = Buffer.concat([
			Buffer.from("aé€😀\n😀b\u{10348}\r\n", "utf-8"),
			Buffer.from([0x61, 0xc3, 0x0a, 0xe2, 0x82, 0x0a, 0xff, 0xfe, 0x80, 0xf0, 0x9f, 0x98, 0x0a, 0xed, 0xa0, 0x80]),
		]);
		for (const chunkSize of [1, 2, 3]) {
			for (const selector of ["", ":raw", ":2-3"]) {
				assertSameOutcome(
					await readWith(streamingOps(bytes, chunkSize), selector),
					referenceOutcome(bytes.toString("utf-8"), selector),
					`chunks of ${chunkSize}, ${selector}`,
				);
			}
		}
	});

	it("uses readFile for operations without createReadStream", async () => {
		const text = "one\ntwo\nthree\nfour";
		const ops: ReadOperations = { readFile: async () => Buffer.from(text), access: async () => {} };
		for (const selector of ["", ":2", ":2-2", ":9", ":raw"]) {
			assertSameOutcome(await readWith(ops, selector), referenceOutcome(text, selector), selector);
		}
	});

	it("reads local files through the default stream", async () => {
		const path = join(TEMP_DIR, "local.txt");
		const text = `${lines(3000, (i) => `${i} ${"w".repeat(i % 40)}`)}\r\n`;
		writeFileSync(path, text);
		const tool = createReadToolDefinition(TEMP_DIR);
		for (const selector of ["", ":1500-1510", ":1500+10:raw", ":2999", ":3001"]) {
			const result = await outcome(() =>
				tool.execute("call", { path: `${path}${selector}` }, undefined, undefined, undefined as never),
			);
			assertSameOutcome(result, referenceOutcome(text, selector, path), selector);
		}
		const directory = await tool.execute("call", { path: TEMP_DIR }, undefined, undefined, undefined as never);
		assert.equal((directory.details as { isDirectory?: boolean }).isDirectory, true);
		await assert.rejects(readLocalFileChunks(TEMP_DIR, {}).next(), { code: "EISDIR" });
	});

	it("reads a local file up to its size when opened, like fs.readFile", async () => {
		const path = join(TEMP_DIR, "growing.txt");
		// Larger than one 64 KB stream chunk, so the append lands before the stream reaches the end.
		writeFileSync(path, `head\n${lines(30_000, () => "xx")}`);
		decodeHook.run = () => {
			decodeHook.run = undefined;
			appendFileSync(path, "\nadded");
		};
		const tool = createReadToolDefinition(TEMP_DIR);
		const result = await tool.execute("call", { path: `${path}:1-1` }, undefined, undefined, undefined as never);
		assert.equal(decodeHook.run, undefined);
		assert.deepEqual(result.content[0], {
			type: "text",
			text: "[Lines 1-4 of 30001]\nhead\nxx\nxx\nxx\n\n[29997 more lines in file. Continue with path selector :5.]",
		});
	});

	// Chunks of one 64 KiB line between short lines at both ends, generated on demand: the text never exists in memory.
	const longLine = Buffer.alloc(64 * 1024, "x");
	longLine[longLine.length - 1] = 0x0a;
	function longLineStream(chunkCount: number, pulled = { count: 0 }): () => AsyncGenerator<Uint8Array> {
		return async function* () {
			pulled.count++;
			yield Buffer.from("alpha\nbeta\ngamma\ndelta\n");
			for (let chunk = 0; chunk < chunkCount; chunk++) {
				pulled.count++;
				yield longLine;
			}
			pulled.count++;
			yield Buffer.from("omega\n");
		};
	}
	function streamOnlyOps(createReadStream: () => AsyncGenerator<Uint8Array>): ReadOperations {
		return {
			readFile: async () => {
				throw new Error("readFile must not be used when createReadStream is present");
			},
			access: async () => {},
			createReadStream,
		};
	}

	it("reads a range of a 2 GiB stream without readFile, pulling each chunk once", async () => {
		const chunkCount = 32_768;
		const pulled = { count: 0 };
		const totalLines = chunkCount + 5;
		assertSameOutcome(
			await readWith(streamOnlyOps(longLineStream(chunkCount, pulled)), ":1-1"),
			textResult(
				`[Lines 1-4 of ${totalLines}]\nalpha\nbeta\ngamma\ndelta\n\n[${totalLines - 4} more lines in file. Continue with path selector :5.]`,
				{ meta: { source: FILE_PATH, sourcePath: FILE_PATH } },
			),
			":1-1",
		);
		assert.equal(pulled.count, chunkCount + 2);
	});

	it("counts every selected line of a large stream but keeps at most the character limit", async () => {
		const chunkCount = 4096;
		const totalLines = chunkCount + 5;
		const last = await readWith(streamOnlyOps(longLineStream(chunkCount)), `:${totalLines}`);
		assert.equal((last as ReadResult).content[0].text, "omega");

		const whole = await selectReadLinesFromChunks(
			longLineStream(chunkCount)(),
			{ firstLine: 1 },
			{ raw: false, maxChars: MAX_CHARS },
		);
		assert.equal(whole.totalLines, totalLines);
		assert.equal(whole.count, totalLines);
		assert.equal(whole.chars, "alpha\nbeta\ngamma\ndelta\nomega".length + chunkCount * longLine.length);
		assert.equal(whole.firstLineBytes, "alpha".length);
		assert.deepEqual(whole.lines, ["alpha", "beta", "gamma", "delta"]);
		assert.deepEqual(whole.lineNumbers, [1, 2, 3, 4]);
	});

	it("stops consuming the stream when aborted, with the signal's reason as the cancellation cause", async () => {
		const controller = new AbortController();
		const reason = new Error("user pressed escape");
		let chunksRead = 0;
		let closed = false;
		const ops: ReadOperations = {
			readFile: async () => Buffer.alloc(0),
			access: async () => {},
			async *createReadStream(_path, { signal }) {
				assert.equal(signal, controller.signal);
				try {
					while (true) {
						chunksRead++;
						if (chunksRead === 3) controller.abort(reason);
						await new Promise((resolve) => setTimeout(resolve, 1));
						yield Buffer.from("line\n");
					}
				} finally {
					closed = true;
				}
			},
		};
		const tool = createReadToolDefinition(TEMP_DIR, { operations: ops });
		const error = await tool
			.execute("call", { path: FILE_PATH }, controller.signal, undefined, undefined as never)
			.then(
				() => undefined,
				(rejection: unknown) => rejection,
			);
		assert.ok(isFileToolAbortedError(error));
		assert.equal(error.code, "aborted");
		assert.equal(error.cause, reason);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(closed, true);
		assert.equal(chunksRead, 3);
	});

	it("rejects a read whose signal is already aborted as a cancellation", async () => {
		const reason = new Error("cancelled before reading");
		const ops = streamingOps(Buffer.from("text"), 4096);
		const tool = createReadToolDefinition(TEMP_DIR, { operations: ops });
		await assert.rejects(
			tool.execute("call", { path: FILE_PATH }, AbortSignal.abort(reason), undefined, undefined as never),
			(error: unknown) => isFileToolAbortedError(error) && error.cause === reason,
		);
	});

	it("removes its abort listener when it finishes", async () => {
		class ListenerCountingSignal extends EventTarget {
			readonly aborted = false;
			readonly reason = undefined;
			abortListeners = 0;
			override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
				if (args[0] === "abort") this.abortListeners++;
				super.addEventListener(...args);
			}
			override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
				if (args[0] === "abort") this.abortListeners--;
				super.removeEventListener(...args);
			}
		}
		for (const [text, selector] of [
			["one\ntwo\n", ""],
			["one\ntwo\n", ":conflicts"],
			[TEXT_CASES.conflict, ":conflicts"],
		]) {
			const signal = new ListenerCountingSignal();
			const tool = createReadToolDefinition(TEMP_DIR, { operations: streamingOps(Buffer.from(text), 4096) });
			await tool.execute(
				"call",
				{ path: `${FILE_PATH}${selector}` },
				signal as unknown as AbortSignal,
				undefined,
				undefined as never,
			);
			assert.equal(signal.abortListeners, 0, `${JSON.stringify(text)}${selector}`);
		}
	});

	it("stops the selection itself between chunks when the signal aborts", async () => {
		const controller = new AbortController();
		const reason = new Error("stop");
		async function* chunks(): AsyncGenerator<Uint8Array> {
			yield Buffer.from("one\n");
			controller.abort(reason);
			yield Buffer.from("two\n");
		}
		await assert.rejects(
			selectReadLinesFromChunks(
				chunks(),
				{ firstLine: 1 },
				{ raw: false, maxChars: MAX_CHARS, signal: controller.signal },
			),
			(error: unknown) => isFileToolAbortedError(error) && error.cause === reason,
		);
	});
});

/** A child Node process loads the read tool from source and decodes 200 MB: structural, not a slow test. */
const CHILD_PROCESS_TIMEOUT_MS = 120_000;
// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;

describe("read tool memory", () => {
	it(
		"reads a 200 MB line with a 64 MB heap",
		() => {
			// A child process, so a regression that stores the whole line runs out of memory instead of passing.
			const readToolUrl = pathToFileURL(fileURLToPath(new URL("../src/core/tools/read.ts", import.meta.url))).href;
			const script = `
				import { createReadToolDefinition } from ${JSON.stringify(readToolUrl)};
				// 64 KB chunks, as fs streams them: larger decoded strings live outside the V8 heap and its limit.
				const chunk = Buffer.alloc(64 * 1024, "x");
				async function* createReadStream() { for (let i = 0; i < 3200; i++) yield chunk; }
				const operations = { readFile: async () => Buffer.alloc(0), access: async () => {}, createReadStream };
				const tool = createReadToolDefinition(process.cwd(), { operations });
				const result = await tool.execute("call", { path: "big.log" });
				process.stdout.write(JSON.stringify(result.details.oversizedRead));
			`;
			const output = execFileSync(
				process.execPath,
				[
					"--max-old-space-size=64",
					"--import",
					`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`,
					"--input-type=module",
					"--eval",
					script,
				],
				{ cwd: TEMP_DIR, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
			);
			const bytes = 3200 * 64 * 1024;
			assert.deepEqual(JSON.parse(output), {
				blocked: true,
				path: join(realpathSync(TEMP_DIR), "big.log"),
				chars: bytes,
				maxChars: MAX_CHARS,
				startLine: 1,
				totalFileLines: 1,
				firstLineBytes: bytes,
				byteGuidance: true,
			});
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);
});

/** Opt-in: writes a file over 2 GiB. Run with ATOMIC_READ_LARGE_FILE_TEST=1 on a machine with the disk space. */
const LARGE_FILE_TEST = process.env.ATOMIC_READ_LARGE_FILE_TEST === "1";
/** Writing and scanning more than 2 GiB is bound by the disk, not by a slow test. */
const LARGE_FILE_TEST_TIMEOUT_MS = 600_000;

describe("read tool on a file over 2 GiB", () => {
	it.runIf(LARGE_FILE_TEST)(
		"reads a range and the last line without loading the file",
		async () => {
			const blockLines = 1024 * 1024;
			const block = Buffer.alloc(blockLines * 64, "x");
			for (let line = 1; line <= blockLines; line++) block[line * 64 - 1] = 0x0a;
			const blocks = 33;
			const path = join(process.env.ATOMIC_READ_LARGE_FILE_DIR ?? TEMP_DIR, `large-${process.pid}.log`);
			writeFileSync(path, "head\n");
			for (let index = 0; index < blocks; index++) appendFileSync(path, block);
			appendFileSync(path, "tail\n");
			try {
				const totalLines = blocks * blockLines + 2;
				const xLine = "x".repeat(63);
				const tool = createReadToolDefinition(TEMP_DIR);
				const read = (selector: string) =>
					tool.execute("call", { path: `${path}${selector}` }, undefined, undefined, undefined as never);
				const peakBefore = process.resourceUsage().maxRSS * 1024;
				const range = await read(":1-1");
				assert.equal(
					range.content[0].type === "text" && range.content[0].text,
					`[Lines 1-4 of ${totalLines}]\nhead\n${xLine}\n${xLine}\n${xLine}\n\n[${totalLines - 4} more lines in file. Continue with path selector :5.]`,
				);
				const last = await read(`:${totalLines}`);
				assert.equal(last.content[0].type === "text" && last.content[0].text, "tail");
				const whole = await read("");
				assert.equal(
					whole.details?.oversizedRead?.chars,
					"head\n".length + blocks * blockLines * 64 + "tail".length,
				);
				assert.equal(whole.details?.oversizedRead?.totalFileLines, totalLines);
				const peakGrowth = process.resourceUsage().maxRSS * 1024 - peakBefore;
				assert.ok(peakGrowth < 256 * 1024 * 1024, `peak memory grew by ${peakGrowth} bytes`);
			} finally {
				rmSync(path, { force: true });
			}
		},
		LARGE_FILE_TEST_TIMEOUT_MS,
	);
});

describe("local file stream", () => {
	it("does not create a file stream for an already aborted signal", async () => {
		const path = join(TEMP_DIR, "aborted.txt");
		writeFileSync(path, "hello\nworld\n");
		const reason = new Error("aborted while opening");
		await assert.rejects(
			readLocalFileChunks(path, { signal: AbortSignal.abort(reason) }).next(),
			(error: unknown) => isFileToolAbortedError(error) && error.cause === reason,
		);
		// Node reports a stream created with an aborted signal as an uncaught error on a later tick.
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

	it("reads an empty file as no chunks", async () => {
		const path = join(TEMP_DIR, "empty.txt");
		writeFileSync(path, "");
		const chunks: Uint8Array[] = [];
		for await (const chunk of readLocalFileChunks(path, {})) chunks.push(chunk);
		assert.deepEqual(chunks, []);
	});

	it.runIf(process.platform === "linux")(
		"reads a file that reports size 0, such as a /proc file, to its end",
		async () => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of readLocalFileChunks("/proc/self/status", {})) chunks.push(chunk);
			assert.match(Buffer.concat(chunks).toString("utf-8"), /^Name:/);
		},
	);

	function fakeOpen(handle: Partial<FileHandle>): typeof fsOpen {
		return (async () => handle as FileHandle) as typeof fsOpen;
	}

	it("keeps the read failure when closing the file also fails", async () => {
		const readFailure = new Error("EIO: read failed");
		const closeFailure = new Error("EBADF: close failed");
		const open = fakeOpen({
			stat: async () => {
				throw readFailure;
			},
			close: async () => {
				throw closeFailure;
			},
		});
		const error = await readLocalFileChunks("file.txt", {}, open)
			.next()
			.then(
				() => undefined,
				(rejection: unknown) => rejection,
			);
		assert.equal(error, readFailure);
		assert.equal((error as Error & { cleanupCause?: unknown }).cleanupCause, closeFailure);
		assert.equal(Object.getOwnPropertyDescriptor(error, "cleanupCause")?.configurable, true);
	});

	it("keeps a non-Error read failure as thrown", async () => {
		const open = fakeOpen({
			stat: async () => {
				throw "stat failed";
			},
			close: async () => {
				throw new Error("close failed");
			},
		});
		await assert.rejects(
			readLocalFileChunks("file.txt", {}, open).next(),
			(error: unknown) => error === "stat failed",
		);
	});

	it("reports a close failure when nothing else failed", async () => {
		const closeFailure = new Error("EBADF: close failed");
		let closes = 0;
		const open = fakeOpen({
			stat: async () => ({ isFile: () => true, size: 0 }) as Awaited<ReturnType<FileHandle["stat"]>>,
			createReadStream: (() => chunked(Buffer.from("text"), 4096)) as unknown as FileHandle["createReadStream"],
			close: async () => {
				closes++;
				throw closeFailure;
			},
		});
		const chunks = readLocalFileChunks("file.txt", {}, open);
		assert.deepEqual((await chunks.next()).value, Buffer.from("text"));
		await assert.rejects(chunks.next(), (error: unknown) => error === closeFailure);
		assert.equal(closes, 1);
	});

	it("closes the file once when the reader stops early", async () => {
		let closes = 0;
		const open = fakeOpen({
			stat: async () => ({ isFile: () => true, size: 8 }) as Awaited<ReturnType<FileHandle["stat"]>>,
			createReadStream: (() => chunked(Buffer.from("one\ntwo\n"), 4)) as unknown as FileHandle["createReadStream"],
			close: async () => {
				closes++;
			},
		});
		for await (const chunk of readLocalFileChunks("file.txt", {}, open)) {
			assert.deepEqual(chunk, Buffer.from("one\n"));
			break;
		}
		assert.equal(closes, 1);
	});
	it("streams a regular file up to its size when opened and other files to their end", async () => {
		const controller = new AbortController();
		for (const [isFile, size, end] of [
			[true, 10, 9],
			[true, 0, undefined],
			[false, 10, undefined],
		] as const) {
			let options: unknown;
			const open = fakeOpen({
				stat: async () => ({ isFile: () => isFile, size }) as Awaited<ReturnType<FileHandle["stat"]>>,
				createReadStream: ((streamOptions: unknown) => {
					options = streamOptions;
					return chunked(Buffer.alloc(0), 1);
				}) as unknown as FileHandle["createReadStream"],
				close: async () => {},
			});
			for await (const _chunk of readLocalFileChunks("file", { signal: controller.signal }, open)) {
				assert.fail("no chunks expected");
			}
			assert.deepEqual(
				options,
				{ end, signal: controller.signal, autoClose: false },
				`isFile ${isFile}, size ${size}`,
			);
		}
	});
});

describe("line selection", () => {
	it("reports line 1 and no bytes when nothing is selected", () => {
		const selection = selectReadLinesFromList(
			["a", "b"],
			{ ranges: [{ start: 3, end: 4 }], exact: false },
			MAX_CHARS,
		);
		assert.deepEqual(selection, {
			totalLines: 2,
			count: 0,
			chars: 0,
			countBeforeTrailingEmpty: 0,
			firstLineNumber: 1,
			firstLineBytes: 0,
			lines: [],
			lineNumbers: [],
		});
	});
});

describe("selected line storage", () => {
	it("keeps only the lines whose joined text fits the character limit", async () => {
		const exact = selectReadLinesFromList(["a".repeat(8), "b"], { firstLine: 1 }, 10);
		assert.deepEqual(exact.lines, ["a".repeat(8), "b"]);
		assert.equal(exact.chars, 10);
		// "b" would make 11 characters; the empty lines after it are counted but never kept.
		const overLines = ["a".repeat(9), "b", "", "", "c"];
		const fromList = selectReadLinesFromList(overLines, { firstLine: 1 }, 10);
		const fromChunks = await selectReadLinesFromChunks(
			chunked(Buffer.from(overLines.join("\n")), 4),
			{ firstLine: 1 },
			{ raw: false, maxChars: 10 },
		);
		for (const over of [fromList, fromChunks]) {
			assert.deepEqual(over.lines, ["a".repeat(9)]);
			assert.deepEqual(over.lineNumbers, [1]);
			assert.equal(over.chars, 15);
			assert.equal(over.count, 5);
			assert.equal(over.countBeforeTrailingEmpty, 5);
		}
	});
});

describe("read range merging", () => {
	it("selects nothing without ranges", () => {
		for (const ranges of [undefined, []]) {
			assert.equal(selectReadRanges(["a"], ranges), undefined);
			assert.equal(selectExactReadRanges(["a"], ranges), undefined);
		}
	});

	it("merges touching and overlapping ranges and keeps gaps", () => {
		assert.deepEqual(
			mergeReadRanges(
				[
					{ start: 1, end: 3 },
					{ start: 3, end: 5 },
				],
				10,
				false,
			),
			[{ start: 1, end: 5 }],
		);
		assert.deepEqual(
			mergeReadRanges(
				[
					{ start: 1, end: 3 },
					{ start: 4, end: 5 },
				],
				10,
				false,
			),
			[{ start: 1, end: 5 }],
		);
		assert.deepEqual(
			mergeReadRanges(
				[
					{ start: 1, end: 3 },
					{ start: 5, end: 6 },
				],
				10,
				false,
			),
			[
				{ start: 1, end: 3 },
				{ start: 5, end: 6 },
			],
		);
		assert.deepEqual(mergeReadRanges([{ start: 9 }, { start: 2, end: 3 }], Number.POSITIVE_INFINITY, true), [
			{ start: 1, end: 6 },
			{ start: 9, end: Number.POSITIVE_INFINITY },
		]);
	});

	it("reports the selected lines with their numbers", () => {
		assert.deepEqual(selectReadRanges(["a", "b", "c", "d", "e", "f", "g"], [{ start: 3, end: 3 }]), {
			selectedLines: ["b", "c", "d", "e", "f"],
			selectedContent: "b\nc\nd\ne\nf",
			firstLine: 2,
			lineNumbers: [2, 3, 4, 5, 6],
			userLimitedLines: 5,
		});
		assert.deepEqual(selectExactReadRanges(["a", "b", "c"], [{ start: 2 }]), {
			selectedLines: ["b", "c"],
			selectedContent: "b\nc",
			firstLine: 2,
			lineNumbers: [2, 3],
			userLimitedLines: 2,
		});
	});
});
