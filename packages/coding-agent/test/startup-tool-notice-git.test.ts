import assert from "node:assert/strict";
import { basename } from "node:path";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.js";
import type { SessionManager } from "../src/core/session-manager.js";
import { reportUnavailableTools } from "../src/modes/interactive/interactive-unavailable-tools.js";
import { resetGitProvisionStateForTest } from "../src/utils/tools-manager.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";
import { createHarness, type Harness } from "./suite/harness.js";

/** Every process this test file's code starts through `child_process`: the file and its arguments. */
const started = vi.hoisted(() => [] as { file: string; args: readonly string[] }[]);

async function recordingChildProcess(actual: typeof import("node:child_process")) {
	const execFile = ((file: string, args: readonly string[], ...rest: unknown[]) => {
		started.push({ file, args });
		return (actual.execFile as (...all: unknown[]) => unknown)(file, args, ...rest);
	}) as typeof actual.execFile;
	const spawnSync = ((file: string, args: readonly string[], ...rest: unknown[]) => {
		started.push({ file, args });
		return (actual.spawnSync as (...all: unknown[]) => unknown)(file, args, ...rest);
	}) as typeof actual.spawnSync;
	return { ...actual, default: { ...actual, execFile, spawnSync }, execFile, spawnSync };
}

vi.mock("child_process", async (importOriginal) =>
	recordingChildProcess(await importOriginal<typeof import("node:child_process")>()),
);
vi.mock("node:child_process", async (importOriginal) =>
	recordingChildProcess(await importOriginal<typeof import("node:child_process")>()),
);

/** The `git --version` runs among the processes started since `from`. */
function gitVersionRuns(from: number): number {
	return started
		.slice(from)
		.filter(({ file, args }) => /^git(\.exe)?$/i.test(basename(file)) && args[0] === "--version").length;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function extensionTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

/** A session whose history used the `deploy` tool, resumed where nothing registers it. */
async function sessionMissingDeploy(): Promise<SessionManager> {
	const before = await createHarness({ customTools: [extensionTool("deploy")] });
	cleanups.push(() => before.cleanup());
	before.setResponses([fauxAssistantMessage("ok")]);
	await before.session.prompt("continue");
	return before.sessionManager;
}

const NOTICE =
	"A tool this session was using isn't available right now: deploy. /tools shows why; /reload retries once that is fixed.";

async function startupNotices(mode: Parameters<typeof reportUnavailableTools>[0]): Promise<string[]> {
	const warnings: string[] = [];
	await reportUnavailableTools({ ...mode, showWarning: (message) => warnings.push(message) });
	return warnings;
}

test("the startup notice of unavailable tools starts no git, and /tools still reports git", async () => {
	const after: Harness = await createHarness({ sessionManager: await sessionMissingDeploy() });
	cleanups.push(() => after.cleanup());
	after.session.agent.state.messages = after.sessionManager.buildSessionContext().messages;
	resetGitProvisionStateForTest();

	const before = started.length;
	assert.deepEqual(await startupNotices({ session: after.session, startupNoticesContainer: undefined as never }), [
		NOTICE,
	]);
	assert.equal(gitVersionRuns(before), 0);

	// What /tools shows still names the git Atomic runs, which it reads by running it.
	const report = await after.session.getToolStatusAsync();
	assert.ok(report.git !== undefined);
	assert.equal(gitVersionRuns(before), report.git.source === "system" ? 1 : 0);
});

test("the isolated engine answers the startup notice without running git, and /tools still reports git", async () => {
	const pair: EngineHostPair = await createEngineHostPair({ sessionManager: await sessionMissingDeploy() });
	cleanups.push(() => pair.cleanup());
	pair.engine.session.agent.state.messages = pair.engine.sessionManager.buildSessionContext().messages;
	resetGitProvisionStateForTest();

	const before = started.length;
	assert.deepEqual(
		await startupNotices({
			runtimeHost: pair.runtime,
			session: pair.hostHarness.session,
			startupNoticesContainer: undefined as never,
		}),
		[NOTICE],
	);
	assert.equal(gitVersionRuns(before), 0);

	const report = await pair.runtime.getToolStatus();
	assert.ok(report.git !== undefined);
	assert.equal(gitVersionRuns(before), report.git.source === "system" ? 1 : 0);
});

test("a host's startup notice reads the same from an engine that always reports git", async () => {
	const pair: EngineHostPair = await createEngineHostPair({ sessionManager: await sessionMissingDeploy() });
	cleanups.push(() => pair.cleanup());
	pair.engine.session.agent.state.messages = pair.engine.sessionManager.buildSessionContext().messages;
	// An engine of an earlier version answers every `get_tools` with the full status, git included.
	const engineSession = pair.engine.session;
	const full = await engineSession.getToolStatusAsync();
	assert.ok(full.git !== undefined);
	vi.spyOn(engineSession, "_getToolStatusWithoutGit").mockReturnValue(full);

	assert.deepEqual(
		await startupNotices({
			runtimeHost: pair.runtime,
			session: pair.hostHarness.session,
			startupNoticesContainer: undefined as never,
		}),
		[NOTICE],
	);
});
