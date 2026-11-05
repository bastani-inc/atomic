import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { CompactionReadyWake } from "../src/core/compaction/background-compaction.ts";
import { BackgroundCompactionConfigError } from "../src/core/compaction/background-compaction-errors.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "sdk-background-compaction-"));
	directories.push(directory);
	return directory;
}

const builtins = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false } as const;

for (const [compaction, reason] of [
	[{ backgroundThresholdPercent: 100 }, "out-of-range"],
	[{ backgroundThresholdPercent: "75" }, "not-a-number"],
	[{ background: "yes" }, "not-a-boolean"],
] as const) {
	test(`createAgentSession rejects ${JSON.stringify(compaction)} before opening session storage (#4330)`, async () => {
		const cwd = tempDir();
		const store = new MemorySessionStore();
		let opened = 0;
		const created = store.create.bind(store);
		store.create = (...args: Parameters<MemorySessionStore["create"]>) => {
			opened += 1;
			return created(...args);
		};
		await assert.rejects(
			createAgentSession({
				cwd,
				agentDir: join(cwd, "agent"),
				builtins,
				settingsManager: SettingsManager.inMemory({ compaction: compaction as never }),
				sessionStore: store,
			}),
			(error: unknown) =>
				error instanceof BackgroundCompactionConfigError &&
				error.source === "settings" &&
				error.reason === reason &&
				error.code === "invalid-setting",
		);
		assert.equal(opened, 0, "no session was created");
	});
}

test("createAgentSession hands the compaction wake dispatcher to the session (#4330)", async () => {
	const cwd = tempDir();
	const wakes: CompactionReadyWake[] = [];
	const compactionWake = { compactionReady: (wake: CompactionReadyWake) => wakes.push(wake) };
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		builtins,
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(cwd),
		compactionWake,
	});
	try {
		assert.equal(
			(session as unknown as { _backgroundCompaction: { wake: unknown } })._backgroundCompaction.wake,
			compactionWake,
		);
		assert.equal(session.compaction.state, "idle");
		assert.equal(session.backgroundCompactionEnabled, true);
	} finally {
		await session.dispose();
	}
});
