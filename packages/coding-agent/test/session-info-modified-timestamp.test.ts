import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

async function createSessionFile(path: string): Promise<void> {
	const header: SessionHeader = {
		type: "session",
		id: "test-session",
		version: 4,
		createdAt: new Date(0).toISOString(),
		cwd: "/tmp",
	};
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");

	// Start with an assistant entry so the later message updates its timestamp.
	const mgr = await SessionManager.open(path);
	await mgr.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

describe("SessionInfo.modified", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("uses last user/assistant message timestamp instead of file mtime", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-modified-"));
		tempDirs.push(dir);
		const filePath = join(dir, "session.jsonl");
		await createSessionFile(filePath);

		const before = await stat(filePath);
		// Ensure the file mtime can differ from our message timestamp even on coarse filesystems.
		await new Promise((r) => setTimeout(r, 10));

		const mgr = await SessionManager.open(filePath);
		const msgTime = Date.now();
		await mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "later" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: msgTime,
		});

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.modified.getTime()).toBe(msgTime);
		expect(s!.modified.getTime()).not.toBe(before.mtime.getTime());
	});
});
