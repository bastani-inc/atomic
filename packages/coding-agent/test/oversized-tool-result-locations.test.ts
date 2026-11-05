/**
 * Where an oversized tool result is spilled (#4309): the session's own directory when it has one, else the released
 * stage's blob directory, else the temp tree. A directory that is only whitespace is no directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, test } from "vitest";
import { redirectOversizedToolResult } from "../src/core/tools/oversized-tool-result.ts";
import { getTempRootDir } from "../src/core/tools/session-temp-dir.ts";
import { DEFAULT_MAX_RESULT_SIZE_CHARS, TOOL_RESULTS_SUBDIR } from "../src/core/tools/tool-limits.ts";

const directories: string[] = [];
afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function spilledTo(options: { readonly sessionDir?: string; readonly blobDir?: string }): Promise<string> {
	const replacement = await redirectOversizedToolResult({
		toolName: "bash",
		toolCallId: "call-1",
		result: { content: [{ type: "text", text: "s".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1) }], details: undefined },
		isError: false,
		sessionId: "spill-location-session",
		...options,
	});
	const first = replacement?.content[0];
	const path = first?.type === "text" ? /Full output saved to: (.+)\n/.exec(first.text)?.[1] : undefined;
	assert.ok(path !== undefined, "the result names its file");
	return path;
}

test("a session directory wins over a blob directory (#4309)", async () => {
	const sessionDir = temporaryDirectory("atomic-spill-own-");
	const blobDir = temporaryDirectory("atomic-spill-blobs-");

	const path = await spilledTo({ sessionDir, blobDir });

	assert.equal(relative(join(sessionDir, TOOL_RESULTS_SUBDIR), path).startsWith(".."), false);
});

test("a session directory that is only whitespace leaves the spill to the blob directory (#4309)", async () => {
	const blobDir = temporaryDirectory("atomic-spill-blobs-");

	const path = await spilledTo({ sessionDir: "   ", blobDir });

	assert.equal(relative(blobDir, path).startsWith(".."), false);
});

test("with neither directory the spill goes to the temp tree (#4309)", async () => {
	const path = await spilledTo({});

	assert.equal(relative(getTempRootDir(), path).startsWith(".."), false);
});
