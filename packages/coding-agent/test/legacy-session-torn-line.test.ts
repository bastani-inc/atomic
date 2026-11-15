import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { getDefaultSessionDirPath } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.js";

useTemporaryAgentDir();

let root: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "legacy-session-torn-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv(ENV_SESSION_DIR, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** Larger than the window a listing reads whole, so the listing reads the session's two ends only. */
const LARGE_SESSION_MESSAGES = 200;

for (const size of ["small", "large"] as const) {
	test(`lists and opens a ${size} legacy session whose last line a crashed writer left unfinished (#4993)`, async () => {
		const createdAt = "2026-10-16T10:00:00.000Z";
		const directory = getDefaultSessionDirPath(cwd, agentDir);
		mkdirSync(directory, { recursive: true });
		const count = size === "small" ? 1 : LARGE_SESSION_MESSAGES;
		const messages = Array.from({ length: count }, (_, index) => ({
			type: "message",
			id: `u${String(index).padStart(7, "0")}`,
			parentId: index === 0 ? null : `u${String(index - 1).padStart(7, "0")}`,
			timestamp: createdAt,
			message: { role: "user", content: `message ${index} ${"x".repeat(256)}`, timestamp: Date.parse(createdAt) },
		}));
		const torn = JSON.stringify({ ...messages[0], id: "torn" }).slice(0, 40);
		writeFileSync(
			join(directory, `${createdAt.replace(/[:.]/g, "-")}_legacy.jsonl`),
			`${[{ type: "session", version: 4, id: "legacy", createdAt, cwd }, ...messages]
				.map((line) => JSON.stringify(line))
				.join("\n")}\n${torn}`,
		);
		const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const store = await resolveSessionStore(cwd, { agentDir, settings: {} });
		try {
			assert.ok(store instanceof LegacySessionStore);
			const listed = [];
			for await (const summary of store.list({ cwd })) listed.push(summary);
			assert.deepEqual(
				listed.map((summary) => [summary.id, summary.firstMessage.startsWith("message 0")]),
				[["legacy", true]],
			);
			assert.equal((await store.load("legacy")).entries.length, count);
		} finally {
			await store.close();
			warnings.mockRestore();
		}
	});
}
