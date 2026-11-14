import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import {
	awaitBlueprintReady,
	blueprintBuildPending,
	holdToolsUntilBuilt,
	holdToolsUntilOwnerBuilt,
	shareBlueprintBuild,
} from "../src/core/resume/blueprint/barrier.ts";
import { BLUEPRINT_BUILDING_CONTEXT } from "../src/core/resume/blueprint/resume.ts";
import { sessionResumeOptions } from "../src/core/resume/session-resume.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import {
	BLUEPRINT_CONTEXT_TYPE,
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
} from "../src/index.ts";
import { forThisHost } from "./helpers/blueprint-fixtures.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	if (!existsSync(gate())) writeFileSync(gate(), "");
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

/** Where the build's step and the agent's `bash` calls write what they did, in order. */
const markers = () => sandbox.path("markers.txt");
/** The file the build's step waits for, so a test decides when the build ends. */
const gate = () => sandbox.path("gate");
const shellPath = (path: string) => path.replaceAll("\\", "/");
const ran = () => (existsSync(markers()) ? readFileSync(markers(), "utf8").trim().split("\n") : []);

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function sqlStore(): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

/** A session that recorded a clone whose blueprint's maintenance waits for {@link gate}; the clone is then gone. */
async function recordedProject(afterGate = ""): Promise<SessionManager> {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const blueprint = [
		"maintenance:",
		"  - name: Install dependencies",
		"    run: |",
		`      echo started >> "${shellPath(markers())}"`,
		`      while [ ! -f "${shellPath(gate())}" ]; do sleep 0.05; done`,
		`      echo built >> "${shellPath(markers())}"`,
		...(afterGate === "" ? [] : [`      ${afterGate}`]),
		"",
	].join("\n");
	sandbox.write(join(clone, ".atomic", "blueprint.yaml"), forThisHost(blueprint));
	const store = await sqlStore();
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "work on it", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error("the fixture's snapshot was not captured");
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	renameSync(clone, sandbox.path("node-a-gone"));
	return manager;
}

function options(waitForBlueprint?: "prompt" | "tools"): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		blueprint: {
			agentDir: sandbox.path("agent"),
			trusted: () => true,
			homeDir: sandbox.path("home"),
			environment: { PATH: process.env.PATH ?? "", HOME: sandbox.path("home") },
		},
		...(waitForBlueprint === undefined ? {} : { waitForBlueprint }),
	};
}

function ready(prepared: PreparedSessionResume) {
	if (prepared.status !== "ready") throw new Error("the resume did not open the session");
	return prepared;
}

function contexts(manager: SessionManager): string[] {
	return manager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom_message" &&
			entry.customType === BLUEPRINT_CONTEXT_TYPE &&
			typeof entry.content === "string"
				? [entry.content]
				: [],
		);
}

/** An agent session on the resumed session whose model calls `bash` once and then answers. */
async function agentCallingBash(manager: SessionManager): Promise<Harness> {
	const harness = await createHarness({ sessionManager: manager, cwd: manager.getCwd() });
	cleanups.push(() => harness.cleanup());
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("bash", { command: `echo ran >> "${shellPath(markers())}"` }, { id: "b-1" })],
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage("done"),
	]);
	return harness;
}

function toolResultText(harness: Harness, toolCallId: string): string {
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	if (result === undefined || result.role !== "toolResult") throw new Error(`no result for ${toolCallId}`);
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("resume.waitForBlueprint lets the first turn overlap the blueprint build (#4748)", () => {
	test('the default "prompt" returns only after the build ended and holds no tool (#4748)', async () => {
		const manager = await recordedProject();
		let settled = false;
		const preparing = prepareSessionResume(manager, options()).then((prepared) => {
			settled = true;
			return prepared;
		});
		await until(() => ran().includes("started"), "the build to start");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(settled, false, "the resume waits for the build");
		writeFileSync(gate(), "");
		const prepared = ready(await preparing);
		assert.deepEqual(ran(), ["started", "built"]);
		assert.equal(blueprintBuildPending(prepared.sessionManager.getSessionId()), false);
		assert.notEqual(prepared.blueprintContext, BLUEPRINT_BUILDING_CONTEXT);
		assert.match(prepared.blueprintContext ?? "", /Install dependencies/);
	});

	test('with "tools" the first request precedes the build end and a bash call waits for the build (#4748)', async () => {
		const manager = await recordedProject();
		const prepared = ready(await prepareSessionResume(manager, options("tools")));
		assert.equal(existsSync(gate()), false, "the resume returned while the build still runs");
		assert.deepEqual(contexts(prepared.sessionManager), [BLUEPRINT_BUILDING_CONTEXT]);
		assert.deepEqual(prepared.blueprintNotices, []);

		const harness = await agentCallingBash(prepared.sessionManager);
		const run = harness.session.prompt("go on");
		await until(() => harness.eventsOfType("tool_execution_start").length > 0, "the bash call");
		assert.equal(harness.getPendingResponseCount(), 1, "the first request went out during the build");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(ran().includes("ran"), false, "the bash call waits for the build");

		writeFileSync(gate(), "");
		await run;
		assert.deepEqual(ran(), ["started", "built", "ran"]);
		const report = toolResultText(harness, "b-1");
		assert.match(report, /^<blueprint_build_finished>\nThe environment build of this resumed session has finished\./);
		assert.match(report, /Install dependencies/);
		assert.equal(blueprintBuildPending(prepared.sessionManager.getSessionId()), false);
	});

	test("a blueprint that fails during the overlapped turn releases the waiting tool with the notice (#4748)", async () => {
		const manager = await recordedProject("exit 3");
		const prepared = ready(await prepareSessionResume(manager, options("tools")));
		const harness = await agentCallingBash(prepared.sessionManager);
		const run = harness.session.prompt("go on");
		await until(() => harness.eventsOfType("tool_execution_start").length > 0, "the bash call");
		writeFileSync(gate(), "");
		await run;

		assert.deepEqual(ran(), ["started", "built", "ran"]);
		const report = toolResultText(harness, "b-1");
		assert.match(report, /finished with problems:\n- Partial build: .*Install dependencies/);
		const assistant = harness.session.messages.filter((message) => message.role === "assistant");
		assert.equal(assistant.length, 2, "the turn went on after the failed build");
		const reopened = await prepared.sessionManager.openSessionById(prepared.sessionManager.getSessionId());
		assert.ok(
			reopened.getBranch().some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
			"the session's history holds the tool result",
		);
	});

	test("interrupting the turn during the wait stops the wait, not the build, and the next tool gets the report (#4748)", async () => {
		const manager = await recordedProject();
		const prepared = ready(await prepareSessionResume(manager, options("tools")));
		const sessionId = prepared.sessionManager.getSessionId();
		const harness = await agentCallingBash(prepared.sessionManager);
		const run = harness.session.prompt("go on");
		await until(() => harness.eventsOfType("tool_execution_start").length > 0, "the bash call");
		await harness.session.abort();
		await run;
		assert.equal(ran().includes("ran"), false, "the interrupted call never ran");
		assert.equal(blueprintBuildPending(sessionId), true);

		writeFileSync(gate(), "");
		const report = await awaitBlueprintReady(sessionId);
		assert.deepEqual(ran(), ["started", "built"], "the build went on to its end");
		assert.match(report ?? "", /has finished\./);
		assert.equal(await awaitBlueprintReady(sessionId), undefined, "the report is told once");
	});
});

describe("the blueprint barrier (#4748)", () => {
	test("an abort rejects the wait with its reason and leaves the build pending (#4748)", async () => {
		const build = Promise.withResolvers<string | undefined>();
		holdToolsUntilBuilt("abort-session", build.promise);
		const controller = new AbortController();
		const waiting = awaitBlueprintReady("abort-session", controller.signal);
		controller.abort(new Error("user interrupted"));
		await assert.rejects(waiting, /user interrupted/);
		assert.equal(blueprintBuildPending("abort-session"), true);
		build.resolve("built");
		assert.equal(await awaitBlueprintReady("abort-session"), "built");
		assert.equal(blueprintBuildPending("abort-session"), false);
	});

	test("a build that rejects releases the wait without a report (#4748)", async () => {
		holdToolsUntilBuilt("rejected-session", Promise.reject(new Error("crashed")));
		assert.equal(await awaitBlueprintReady("rejected-session"), undefined);
		assert.equal(blueprintBuildPending("rejected-session"), false);
	});

	test("the isolated engine waits for the build its host process shares, and reads its report (#4748)", async () => {
		const storeDir = sandbox.path("host");
		const build = Promise.withResolvers<string | undefined>();
		holdToolsUntilBuilt("shared-session", build.promise);
		await shareBlueprintBuild(storeDir, "shared-session");
		holdToolsUntilOwnerBuilt(storeDir, process.pid, "shared-session");
		let report: string | undefined | null = null;
		const waiting = awaitBlueprintReady("shared-session").then((value) => {
			report = value;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(report, null, "the engine waits while the host builds");
		build.resolve("host built");
		await waiting;
		assert.equal(report, "host built");
	});

	test("an engine whose host shared no build holds nothing (#4748)", () => {
		holdToolsUntilOwnerBuilt(sandbox.path("host"), process.pid, "unshared-session");
		assert.equal(blueprintBuildPending("unshared-session"), false);
	});
});

test('resume.waitForBlueprint defaults to "prompt" and reaches the resume options (#4748)', () => {
	const trusted = () => true;
	const defaults = sessionResumeOptions("cli", "/work", "/agent", SettingsManager.inMemory(), trusted);
	assert.equal(defaults.waitForBlueprint, "prompt");
	const overlapping = SettingsManager.inMemory({ resume: { waitForBlueprint: "tools" } });
	assert.equal(sessionResumeOptions("cli", "/work", "/agent", overlapping, trusted).waitForBlueprint, "tools");
});
