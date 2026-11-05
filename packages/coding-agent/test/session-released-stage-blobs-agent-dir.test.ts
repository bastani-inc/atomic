/**
 * Where deleting a session looks for the oversized tool results its released workflow stage kept (#4309): the agent
 * directory the session was created with, or the default agent directory for a session manager nobody bound.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getReleasedStageBlobDir } from "../src/core/tools/tool-output-blobs.ts";

function leaveBlob(agentDir: string, sessionId: string): string {
	const directory = getReleasedStageBlobDir(agentDir, sessionId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "result.txt"), "spilled");
	return directory;
}

describe("deleting a session removes its released-stage tool results (#4309)", () => {
	let root: string;
	let defaultAgentDir: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-blob-agent-dir-"));
		defaultAgentDir = join(root, "default-agent");
		agentDir = join(root, "agent");
		mkdirSync(defaultAgentDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, defaultAgentDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	test("from the agent directory a session was created with (#4309)", async () => {
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			extensionFactories: [() => {}],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			const own = leaveBlob(agentDir, "other-session");
			const blobsOfDefault = leaveBlob(defaultAgentDir, "other-session");

			await session.sessionManager.deleteSession("other-session");

			assert.equal(existsSync(own), false);
			assert.equal(existsSync(blobsOfDefault), true, "the default agent directory is not this session's");
		} finally {
			session.dispose();
		}
	});

	test("from the default agent directory when nobody bound the session manager to one (#4309)", async () => {
		const own = leaveBlob(defaultAgentDir, "other-session");
		const unrelated = leaveBlob(agentDir, "other-session");

		await SessionManager.inMemory().deleteSession("other-session");

		assert.equal(existsSync(own), false);
		assert.equal(existsSync(unrelated), true);
	});
});
