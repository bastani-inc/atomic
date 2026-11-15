/**
 * `boundOversizedText` (#4907): extension text bounded in the model's context the way an oversized tool result is.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { boundOversizedText } from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "bound-text-"));
	directories.push(directory);
	return directory;
}

test("text within the limit is returned unchanged, measured in UTF-8 bytes (#4907)", async () => {
	const text = "é".repeat(5);
	assert.equal(
		await boundOversizedText({ text, maxBytes: 10, sessionId: "s", sessionDir: temporaryDirectory() }),
		text,
	);
});

test("longer text is saved to a session file and replaced by a preview naming it (#4907)", async () => {
	const sessionDir = temporaryDirectory();
	const text = `${"line\n".repeat(1_000)}tail`;
	const bounded = await boundOversizedText({ text, maxBytes: 100, sessionId: "s", sessionDir });
	const path = /^Output too large \(4.9KB\)\. Full output saved to: (.+)$/m.exec(bounded)?.[1];
	assert.ok(path, bounded);
	assert.ok(path.startsWith(join(sessionDir, "tool-results")), path);
	assert.equal(readFileSync(path, "utf8"), text);
	assert.match(bounded, /^<persisted-output>\n/);
	assert.match(bounded, /\nContent: sha256:[0-9a-f]{64}\n\nPreview \(first 2KB\):\nline\n/);
	assert.match(bounded, /line\n\.\.\.\n<\/persisted-output>$/);
	assert.ok(bounded.length < 2_500);
});

test("a preview that holds all the text has no ellipsis (#4907)", async () => {
	const bounded = await boundOversizedText({
		text: "0123456789ab",
		maxBytes: 10,
		sessionId: "s",
		sessionDir: temporaryDirectory(),
	});
	assert.match(bounded, /\n0123456789ab\n<\/persisted-output>$/);
});

test("text that cannot be saved keeps only its preview and says so (#4907)", async () => {
	const notADirectory = join(temporaryDirectory(), "file");
	writeFileSync(notADirectory, "");
	const bounded = await boundOversizedText({
		text: `${"x".repeat(3_000)}`,
		maxBytes: 100,
		sessionId: "s",
		sessionDir: notADirectory,
	});
	assert.equal(
		bounded,
		`<persisted-output>\nOutput too large (2.9KB) and could not be saved to a file; only this preview was kept.\n\nPreview (first 2KB):\n${"x".repeat(2_000)}\n...\n</persisted-output>`,
	);
	const whole = await boundOversizedText({
		text: "0123456789ab",
		maxBytes: 10,
		sessionId: "s",
		sessionDir: notADirectory,
	});
	assert.match(whole, /kept\.\n\nPreview \(first 2KB\):\n0123456789ab\n<\/persisted-output>$/);
});
