import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import * as markers from "../src/core/session-open-markers.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const UNANSWERED_PREPARATION_RELEASE_MS = 5_000;

test("creating sessions does not wait for this process's unanswered marker start read (#5315)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-sdk-start-"));
	let finishPreparation!: () => void;
	let preparationWasRequired = false;
	const preparing = new Promise<void>((resolve) => {
		finishPreparation = resolve;
	});
	const read = vi.spyOn(markers, "prepareSessionOpenMarkers").mockReturnValue(preparing);
	const release = setTimeout(() => {
		preparationWasRequired = true;
		finishPreparation();
	}, UNANSWERED_PREPARATION_RELEASE_MS);
	try {
		for (let index = 0; index < 2; index++) {
			const { session } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				sessionManager: SessionManager.inMemory(directory),
				settingsManager: SettingsManager.inMemory(),
				builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
			});
			await session.dispose();
		}
		assert.equal(preparationWasRequired, false);
	} finally {
		clearTimeout(release);
		finishPreparation();
		read.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	}
});
