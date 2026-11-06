/**
 * Where an oversized tool result is spilled (#4309): the session's own directory when it has one, else where the
 * caller's `persist` keeps it (a blob of a released stage's session, #4379), else the temp tree. A directory that is
 * only whitespace is no directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, test } from "vitest";
import {
	type PersistToolOutput,
	type RedirectOversizedToolResultInput,
	redirectOversizedToolResult,
} from "../src/core/tools/oversized-tool-result.js";
import { capPersistedText } from "../src/core/tools/persisted-output-file.js";
import { getTempRootDir } from "../src/core/tools/session-temp-dir.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS, TOOL_RESULTS_SUBDIR } from "../src/core/tools/tool-limits.js";

const directories: string[] = [];
afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

const OUTPUT = "s".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1);

function spill(options: Pick<RedirectOversizedToolResultInput, "sessionDir" | "persist">) {
	return redirectOversizedToolResult({
		toolName: "bash",
		toolCallId: "call-1",
		result: { content: [{ type: "text", text: OUTPUT }], details: undefined },
		isError: false,
		sessionId: "spill-location-session",
		...options,
	});
}

async function spilledTo(options: Pick<RedirectOversizedToolResultInput, "sessionDir" | "persist">): Promise<string> {
	const first = (await spill(options))?.content[0];
	const path = first?.type === "text" ? /Full output saved to: (.+)\n/.exec(first.text)?.[1] : undefined;
	assert.ok(path !== undefined, "the result names where its output is");
	return path;
}

/** A `persist` that records what it was given and keeps it nowhere. */
function recordingPersist(): { readonly persist: PersistToolOutput; readonly stored: string[] } {
	const stored: string[] = [];
	return {
		stored,
		persist: async (text) => {
			stored.push(text);
			return { location: "tool-output://kept", sha256: "kept" };
		},
	};
}

test("a session directory wins over persist (#4309, #4379)", async () => {
	const sessionDir = temporaryDirectory("atomic-spill-own-");
	const { persist, stored } = recordingPersist();

	const path = await spilledTo({ sessionDir, persist });

	assert.equal(relative(join(sessionDir, TOOL_RESULTS_SUBDIR), path).startsWith(".."), false);
	assert.deepEqual(stored, []);
});

test("a session directory that is only whitespace leaves the spill to persist, with the capped text (#4379)", async () => {
	const { persist, stored } = recordingPersist();

	const first = (await spill({ sessionDir: "   ", persist }))?.content[0];

	assert.deepEqual(stored, [capPersistedText(OUTPUT)]);
	assert.ok(first?.type === "text");
	assert.match(first.text, /Full output saved to: tool-output:\/\/kept\nContent: sha256:kept\n/);
});

test("a failure to persist is the redirect's failure, not an unchanged result (#4379)", async () => {
	const failure = new Error("store unavailable");

	await assert.rejects(
		spill({
			persist: async () => {
				throw failure;
			},
		}),
		(error) => error === failure,
	);
});

test("a session directory that is only whitespace, without persist, leaves the spill to the temp tree (#4309)", async () => {
	const path = await spilledTo({ sessionDir: "   " });

	assert.equal(relative(getTempRootDir(), path).startsWith(".."), false);
});

test("with neither a directory nor persist the spill goes to the temp tree (#4309)", async () => {
	const path = await spilledTo({});

	assert.equal(relative(getTempRootDir(), path).startsWith(".."), false);
});
