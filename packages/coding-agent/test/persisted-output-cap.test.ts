/**
 * The 64 MB persisted-output cap: no single tool-output file may grow past it,
 * and whatever is dropped is replaced by a visible truncation marker.
 *
 * The cap itself is asserted as a constant; the truncation behaviour is
 * exercised with an injected byte budget so the suite never has to write 64 MB.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { sleep } from "../../../test/helpers/runtime.ts";
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

/**
 * Budget for observing an asynchronous stream failure. Generous on purpose: the
 * assertion is that the error is *captured* rather than thrown, not that it
 * arrives quickly, and the loop exits as soon as it does.
 */
const ERROR_POLL_ATTEMPTS = 200;
const ERROR_POLL_INTERVAL_MS = 10;

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

	it("keeps a stream error off the fire-and-forget path", async () => {
		// A directory cannot be opened for writing: the stream fails asynchronously,
		// which is exactly the shape that used to escape as an uncaught exception.
		const directoryPath = join(sandbox, "not-a-file");
		mkdirSync(directoryPath, { recursive: true });

		const file = new PersistedOutputFile(directoryPath, { maxBytes: markerBytes + 1024 });
		file.write("content");
		file.end();
		// Poll rather than sleeping a fixed span: how long the stream takes to report
		// EISDIR is a property of the machine's load, not of the behaviour under test.
		for (let attempt = 0; attempt < ERROR_POLL_ATTEMPTS && !file.error; attempt++) {
			await sleep(ERROR_POLL_INTERVAL_MS);
		}

		assert.ok(file.error, "the failure is captured on the file rather than thrown at the process");
		await assert.rejects(() => file.close());
	});
});
