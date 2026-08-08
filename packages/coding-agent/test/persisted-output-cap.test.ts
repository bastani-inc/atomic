/**
 * The 64 MB persisted-output cap: no single tool-output file may grow past it,
 * and whatever is dropped is replaced by a visible truncation marker.
 *
 * The cap itself is asserted as a constant; the truncation behaviour is
 * exercised with an injected byte budget so the suite never has to write 64 MB.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../../../test/helpers/runtime.ts";
import {
	capPersistedText,
	PersistedOutputFile,
	truncateBufferAtUtf8Boundary,
} from "../src/core/tools/persisted-output-file.ts";
import { MAX_PERSISTED_OUTPUT_BYTES, PERSISTED_OUTPUT_TRUNCATION_MARKER } from "../src/core/tools/tool-limits.ts";

let sandbox: string;

beforeAll(() => {
	sandbox = mkdtempSync(join(tmpdir(), "atomic-persisted-output-cap-"));
});

afterAll(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

const markerBytes = Buffer.byteLength(PERSISTED_OUTPUT_TRUNCATION_MARKER, "utf8");

describe("persisted-output cap", () => {
	it("is 64 MB", () => {
		assert.equal(MAX_PERSISTED_OUTPUT_BYTES, 64 * 1024 * 1024);
	});

	it("leaves text within the cap untouched", () => {
		const text = "small output\n";
		assert.equal(capPersistedText(text, 1024), text);
		assert.equal(capPersistedText(text), text);
	});

	it("truncates oversized text with a marker and stays within the cap", () => {
		const cap = markerBytes + 100;
		const capped = capPersistedText("a".repeat(10_000), cap);
		assert.ok(capped.endsWith(PERSISTED_OUTPUT_TRUNCATION_MARKER));
		assert.equal(Buffer.byteLength(capped, "utf8"), cap);
		assert.equal(capped.slice(0, 100), "a".repeat(100));
	});

	it("never splits a multi-byte character at the cap", () => {
		// "é" is two bytes; an odd budget must drop the whole character.
		const cap = markerBytes + 3;
		const capped = capPersistedText("é".repeat(100), cap);
		assert.equal(capped, `é${PERSISTED_OUTPUT_TRUNCATION_MARKER}`);
		assert.ok(Buffer.byteLength(capped, "utf8") <= cap);
		assert.equal(truncateBufferAtUtf8Boundary(Buffer.from("é", "utf8"), 1).length, 0);
	});

	it("stops a streaming spill file at the cap and marks the truncation", async () => {
		const cap = markerBytes + 64;
		const file = new PersistedOutputFile(join(sandbox, "streamed.log"), { maxBytes: cap });
		for (let i = 0; i < 10; i++) {
			file.write(Buffer.from("0123456789abcdef", "utf8"));
		}
		file.write("ignored after the cap");
		assert.equal(file.truncated, true);
		await file.close();

		const contents = readFileSync(file.path, "utf8");
		assert.equal(statSync(file.path).size, cap);
		assert.ok(contents.endsWith(PERSISTED_OUTPUT_TRUNCATION_MARKER));
		assert.equal(contents.slice(0, 64), "0123456789abcdef".repeat(4));
		assert.equal(contents.includes("ignored after the cap"), false);
	});

	it("writes a file smaller than the cap unchanged", async () => {
		const file = new PersistedOutputFile(join(sandbox, "under-cap.log"), { maxBytes: markerBytes + 1024 });
		file.write("line one\n");
		file.write(Buffer.from("line two\n", "utf8"));
		assert.equal(file.truncated, false);
		await file.close();
		assert.equal(readFileSync(file.path, "utf8"), "line one\nline two\n");
	});

	it("preserves streaming input that lands exactly on the cap", async () => {
		const cap = markerBytes + 64;
		const payload = "x".repeat(cap);
		assert.equal(Buffer.byteLength(payload, "utf8"), cap);

		const file = new PersistedOutputFile(join(sandbox, "exact-cap.log"), { maxBytes: cap });
		for (let offset = 0; offset < payload.length; offset += 16) {
			file.write(Buffer.from(payload.slice(offset, offset + 16), "utf8"));
		}
		assert.equal(file.truncated, false, "input exactly at the cap is not truncated");
		await file.close();

		assert.equal(statSync(file.path).size, cap);
		assert.equal(readFileSync(file.path, "utf8"), payload);
	});

	it("marks the truncation as soon as streaming input passes the cap by one byte", async () => {
		const cap = markerBytes + 64;
		const payload = "x".repeat(cap);
		const file = new PersistedOutputFile(join(sandbox, "one-over-cap.log"), { maxBytes: cap });
		file.write(Buffer.from(payload, "utf8"));
		assert.equal(file.truncated, false, "the cap itself is not a truncation");

		file.write("!");
		assert.equal(file.truncated, true);
		await file.close();

		const contents = readFileSync(file.path, "utf8");
		assert.equal(statSync(file.path).size, cap);
		assert.ok(contents.endsWith(PERSISTED_OUTPUT_TRUNCATION_MARKER));
		assert.equal(contents, `${"x".repeat(cap - markerBytes)}${PERSISTED_OUTPUT_TRUNCATION_MARKER}`);
	});

	it("never splits a character written across two chunks, even when the cap intervenes", async () => {
		// The emoji straddles the cap: its first byte arrives in one write and the
		// rest in the write that overruns. A lead byte flushed early would be
		// orphaned in front of the marker and decode as U+FFFD.
		const cap = markerBytes + 64;
		const emoji = Buffer.from("🙂", "utf8");
		const filler = Buffer.from("a".repeat(cap - markerBytes - 2), "utf8");

		const file = new PersistedOutputFile(join(sandbox, "split-char.log"), { maxBytes: cap });
		file.write(filler);
		file.write(emoji.subarray(0, 1));
		file.write(Buffer.concat([emoji.subarray(1), Buffer.from("b".repeat(cap), "utf8")]));
		assert.equal(file.truncated, true);
		await file.close();

		const contents = readFileSync(file.path);
		assert.ok(statSync(file.path).size <= cap);
		const beforeMarker = contents.subarray(0, contents.length - markerBytes);
		assert.equal(
			beforeMarker.toString("utf8").includes("\uFFFD"),
			false,
			`content before the marker must decode cleanly, got ${beforeMarker.toString("hex")}`,
		);
		assert.equal(
			contents.subarray(contents.length - markerBytes).toString("utf8"),
			PERSISTED_OUTPUT_TRUNCATION_MARKER,
		);
	});

	it("preserves raw continuation bytes before the truncation marker", async () => {
		const cap = markerBytes + 4;
		const file = new PersistedOutputFile(join(sandbox, "binary-continuations-at-cap.log"), { maxBytes: cap });

		file.write(Buffer.alloc(cap + 1, 0x80));
		await file.close();

		const contents = readFileSync(file.path);
		assert.equal(contents.length, cap);
		assert.deepEqual(contents.subarray(0, 4), Buffer.alloc(4, 0x80));
		assert.equal(contents.subarray(4).toString("utf8"), PERSISTED_OUTPUT_TRUNCATION_MARKER);
	});

	it("does not treat an invalid UTF-8 lead as a character boundary", async () => {
		const cap = markerBytes + 4;
		const prefix = Buffer.from([0x61, 0x62, 0xc0, 0x80]);
		const file = new PersistedOutputFile(join(sandbox, "invalid-lead-at-cap.log"), { maxBytes: cap });

		file.write(Buffer.concat([prefix, Buffer.alloc(markerBytes + 1, 0x80)]));
		await file.close();

		const contents = readFileSync(file.path);
		assert.equal(contents.length, cap);
		assert.deepEqual(contents.subarray(0, 4), prefix);
		assert.equal(contents.subarray(4).toString("utf8"), PERSISTED_OUTPUT_TRUNCATION_MARKER);
	});

	it("preserves strict UTF-8 range violations as raw binary", () => {
		const malformedPrefixes = [
			Buffer.from([0xe0, 0x80, 0x80]), // overlong three-byte sequence
			Buffer.from([0xed, 0xa0, 0x80]), // UTF-16 surrogate
			Buffer.from([0xf0, 0x80, 0x80, 0x80]), // overlong four-byte sequence
			Buffer.from([0xf4, 0x90, 0x80, 0x80]), // above U+10FFFF
		];

		for (const bytes of malformedPrefixes) {
			assert.deepEqual(truncateBufferAtUtf8Boundary(bytes, 1), bytes.subarray(0, 1));
		}
	});

	it("reassembles an exact-cap payload split mid-character across chunks", async () => {
		const emoji = Buffer.from("🙂", "utf8");
		const cap = markerBytes + 64;
		const filler = Buffer.from("c".repeat(cap - emoji.length), "utf8");
		const payload = Buffer.concat([filler, emoji]);
		assert.equal(payload.length, cap);

		const file = new PersistedOutputFile(join(sandbox, "exact-cap-split.log"), { maxBytes: cap });
		file.write(payload.subarray(0, payload.length - 2));
		file.write(payload.subarray(payload.length - 2));
		assert.equal(file.truncated, false);
		await file.close();

		assert.deepEqual(readFileSync(file.path), payload);
	});

	it("passes raw binary through unchanged when it fits under the cap", async () => {
		// 0xf0 followed by a non-continuation byte is not a UTF-8 sequence; holding
		// it back forever, or decoding it, would corrupt binary command output.
		const payload = Buffer.from([0x61, 0xf0, 0x00, 0xff, 0x62, 0x80]);
		const file = new PersistedOutputFile(join(sandbox, "binary.log"), { maxBytes: markerBytes + 1024 });
		for (const byte of payload) {
			file.write(Buffer.from([byte]));
		}
		assert.equal(file.truncated, false);
		await file.close();

		assert.deepEqual(readFileSync(file.path), payload);
	});

	it("refuses to create a spill file over anything that already exists", () => {
		// Owning the descriptor moved this failure from an asynchronous stream error
		// to a synchronous throw, which is what lets every caller fail closed before
		// it has a path to advertise. A directory and a plain file both refuse.
		const directoryPath = join(sandbox, "not-a-file");
		mkdirSync(directoryPath, { recursive: true });
		const occupiedPath = join(sandbox, "already-here.log");
		writeFileSync(occupiedPath, "someone else's file");

		assert.throws(() => new PersistedOutputFile(directoryPath, { maxBytes: markerBytes + 1024 }));
		assert.throws(() => new PersistedOutputFile(occupiedPath, { maxBytes: markerBytes + 1024 }));
		assert.equal(readFileSync(occupiedPath, "utf8"), "someone else's file", "the existing file is untouched");
	});

	it.skipIf(process.platform === "win32")("keeps persisted files at 0600 under any process umask", () => {
		// `mode` on open is only a request: the umask subtracts from it, and a umask
		// of 0o777 leaves the file at 000 — advertised but unreadable. The umask is
		// process-wide, so this runs in a child rather than corrupting the suite.
		const workDir = join(sandbox, "umask-child");
		mkdirSync(workDir, { recursive: true });
		const packageRoot = dirname(moduleDir(import.meta.url));
		const scriptPath = join(workDir, "umask-probe.ts");
		writeFileSync(
			scriptPath,
			`
process.umask(0o777);
const { statSync } = await import("node:fs");
const { join } = await import("node:path");
const { PersistedOutputFile } = await import(${JSON.stringify(join(packageRoot, "src/core/tools/persisted-output-file.ts"))});
const { redirectOversizedToolResult } = await import(${JSON.stringify(join(packageRoot, "src/core/tools/oversized-tool-result.ts"))});
const { DEFAULT_MAX_RESULT_SIZE_CHARS } = await import(${JSON.stringify(join(packageRoot, "src/core/tools/tool-limits.ts"))});

const streamed = new PersistedOutputFile(join(${JSON.stringify(workDir)}, "streamed.log"));
streamed.write("hello");
await streamed.close();

const replacement = await redirectOversizedToolResult({
	toolName: "bash",
	toolCallId: "umask-call",
	result: { content: [{ type: "text", text: "z".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1) }], details: {} },
	isError: false,
	sessionId: "umask-session",
	sessionDir: ${JSON.stringify(workDir)},
});
const completePath = replacement?.content[0]?.text.match(/Full output saved to: (.+)\\n/)?.[1];

process.stdout.write(
	JSON.stringify({
		streamedMode: statSync(streamed.path).mode & 0o777,
		completePath,
		completeMode: completePath ? statSync(completePath).mode & 0o777 : undefined,
	}),
);
`,
		);

		const result = spawnSyncCollect([bunExecutable(), scriptPath], { cwd: packageRoot });
		assert.equal(result.exitCode, 0, `child failed: ${result.stderr}`);
		const observed = JSON.parse(result.stdout) as {
			streamedMode: number;
			completePath?: string;
			completeMode?: number;
		};

		assert.equal(observed.streamedMode, 0o600, "a streamed spill file must stay readable by its owner");
		assert.ok(observed.completePath, "the oversized result must still be persisted");
		assert.equal(observed.completeMode, 0o600, "a complete persisted result must stay readable by its owner");
	});
});
