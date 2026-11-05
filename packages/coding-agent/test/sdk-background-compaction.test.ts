import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { CompactionReadyWake } from "../src/core/compaction/background-compaction.ts";
import { BackgroundCompactionConfigError } from "../src/core/compaction/background-compaction-errors.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

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
	test(`createAgentSession opens with ${JSON.stringify(compaction)} and runs with background compaction off (#4330)`, async () => {
		const cwd = tempDir();
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			builtins,
			settingsManager: SettingsManager.inMemory({ compaction: compaction as never }),
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			assert.equal(session.backgroundCompactionEnabled, false);
			assert.equal(session.backgroundCompactionThresholdPercent, 75);
			const state = session.compaction;
			assert.equal(state.state, "failed");
			assert.ok(state.error instanceof BackgroundCompactionConfigError);
			assert.equal(state.error.source, "settings");
			assert.equal(state.error.reason, reason);
		} finally {
			await session.dispose();
		}
	});
}

test("a settings file with an invalid background value is reported as a settings error when it loads (#4330)", () => {
	const cwd = tempDir();
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { backgroundThresholdPercent: 0 } }));
	const errors = SettingsManager.create(cwd, agentDir).drainErrors();
	assert.equal(errors.length, 1);
	assert.equal(errors[0].scope, "global");
	assert.ok(errors[0].error instanceof BackgroundCompactionConfigError);
	assert.equal(errors[0].error.reason, "out-of-range");
});

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
