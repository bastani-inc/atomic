import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import {
	awaitBlueprintReady,
	BLUEPRINT_GATED_TOOLS,
	blueprintBuildPending,
	holdToolsUntilBuilt,
	holdToolsUntilOwnerBuilt,
} from "../src/core/resume/blueprint/barrier.ts";
import type { BlueprintBuildOutcome } from "../src/core/resume/blueprint/build.ts";
import { BLUEPRINT_BUILDING_CONTEXT, blueprintBuildReport } from "../src/core/resume/blueprint/resume.ts";
import { resumeStoreDir, sessionResumeOptions } from "../src/core/resume/session-resume.ts";
import { latestResumeTimings, type ResumeTimings } from "../src/core/resume/timings.ts";
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
/** What the agent's `bash` call saw of the variable the build's step writes to `$ENVRC`. */
const environment = () => sandbox.path("environment.txt");
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
async function recordedProject(afterGate = "", gone = true, name = "repo"): Promise<SessionManager> {
	const { clone } = await sandbox.remoteWithClone(name, { "README.md": "hello\n" });
	const blueprint = [
		"maintenance:",
		"  - name: Install dependencies",
		"    run: |",
		`      echo started >> "${shellPath(markers())}"`,
		`      while [ ! -f "${shellPath(gate())}" ]; do sleep 0.05; done`,
		`      echo built >> "${shellPath(markers())}"`,
		'      echo "S9_BUILT_BY=blueprint" >> "$ENVRC"',
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
	if (gone) renameSync(clone, sandbox.path("node-a-gone"));
	return manager;
}

function options(waitForBlueprint?: "prompt" | "tools"): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: resumeStoreDir(sandbox.path("agent")),
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
	const harness = await createHarness({
		sessionManager: manager,
		cwd: manager.getCwd(),
		storageAgentDir: sandbox.path("agent"),
	});
	cleanups.push(() => harness.cleanup());
	harness.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"bash",
					{
						command: `echo ran >> "${shellPath(markers())}"; echo "$S9_BUILT_BY" > "${shellPath(environment())}"`,
					},
					{ id: "b-1" },
				),
			],
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage("done"),
	]);
	return harness;
}

/** The timings the host process of {@link hostSharingBuild} hands over with its settled build. */
const HANDED_OVER_TIMINGS: ResumeTimings = {
	version: 1,
	startedAt: "2026-11-14T00:00:00.000Z",
	restores: [],
	blueprint: [{ section: "maintenance", name: "Install dependencies", ms: 900, exit: "ok" }],
	firstPromptReadyMs: 100,
	blueprintReadyMs: 1000,
};

/**
 * A separate process that, like the interactive host, runs a build for `sessionId` and shares it under the test's
 * store; a line written to its stdin settles the build with that line as its report.
 */
async function hostSharingBuild(sessionId: string): Promise<ChildProcessWithoutNullStreams> {
	const barrier = new URL("../src/core/resume/blueprint/barrier.ts", import.meta.url).href;
	const script = `
		const barrier = await import(${JSON.stringify(barrier)});
		const build = Promise.withResolvers();
		barrier.holdToolsUntilBuilt(${JSON.stringify(sessionId)}, build.promise);
		await barrier.shareBlueprintBuild(${JSON.stringify(sandbox.path("host"))}, ${JSON.stringify(sessionId)});
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", (line) => {
			barrier.handOverBuildTimings(${JSON.stringify(sessionId)}, ${JSON.stringify(HANDED_OVER_TIMINGS)});
			build.resolve(line.trim());
		});
		process.stdout.write("shared\\n");
	`;
	const host = spawn(process.execPath, [
		"--experimental-strip-types",
		"--no-warnings",
		"--input-type=module",
		"-e",
		script,
	]);
	cleanups.push(() => {
		host.kill("SIGKILL");
	});
	await new Promise<void>((resolve, reject) => {
		host.stdout.once("data", () => resolve());
		host.once("exit", (code) => reject(new Error(`the host process exited with ${code}`)));
	});
	return host;
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
		const timings = latestResumeTimings(prepared.sessionManager);
		assert.deepEqual(
			timings?.blueprint.map((step) => step.name),
			["Install dependencies"],
		);
		assert.ok((timings?.blueprintReadyMs ?? Number.NaN) <= (timings?.firstPromptReadyMs ?? Number.NaN));
	});

	test('with "tools" the first request precedes the build end and a bash call waits for the build (#4748)', async () => {
		const manager = await recordedProject();
		const prepared = ready(await prepareSessionResume(manager, options("tools")));
		assert.equal(existsSync(gate()), false, "the resume returned while the build still runs");
		assert.deepEqual(contexts(prepared.sessionManager), [BLUEPRINT_BUILDING_CONTEXT]);
		assert.match(
			BLUEPRINT_BUILDING_CONTEXT,
			/^<blueprint_context>\n.*is still being built.*\n<\/blueprint_context>$/,
		);
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
		assert.equal(readFileSync(environment(), "utf8").trim(), "blueprint", "bash sees the build's $ENVRC");
		const report = toolResultText(harness, "b-1");
		assert.match(report, /^<blueprint_build_finished>\nThe environment build of this resumed session has finished\./);
		assert.match(report, /Install dependencies/);
		assert.equal(blueprintBuildPending(prepared.sessionManager.getSessionId()), false);
		const timings = latestResumeTimings(prepared.sessionManager);
		assert.deepEqual(
			timings?.blueprint.map((step) => step.name),
			["Install dependencies"],
			"the build's steps are recorded once it settled",
		);
		assert.ok(
			(timings?.firstPromptReadyMs ?? Number.NaN) < (timings?.blueprintReadyMs ?? Number.NaN),
			"the session was ready before the build settled",
		);
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

	test("tools that neither run project code nor read the worktree run during the build; a tool that declares writesFiles waits (#4748)", async () => {
		const manager = await recordedProject();
		const prepared = ready(await prepareSessionResume(manager, options("tools")));
		const executed: string[] = [];
		const tool = (name: string, writesFiles: boolean): ToolDefinition => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			...(writesFiles ? { writesFiles: true } : {}),
			execute: async () => {
				executed.push(`${name} ${ran().includes("built") ? "after" : "during"} the build`);
				return { content: [{ type: "text", text: `${name} done` }], details: undefined };
			},
		});
		const harness = await createHarness({
			sessionManager: prepared.sessionManager,
			cwd: prepared.sessionManager.getCwd(),
			customTools: [tool("note", false), tool("generate", true)],
		});
		cleanups.push(() => harness.cleanup());
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("note", {}, { id: "n-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("generate", {}, { id: "g-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const run = harness.session.prompt("go on");
		await until(() => harness.eventsOfType("tool_execution_start").length > 1, "the generate call");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(executed, ["note during the build"]);
		assert.equal(toolResultText(harness, "n-1"), "note done");
		writeFileSync(gate(), "");
		await run;
		assert.deepEqual(executed, ["note during the build", "generate after the build"]);
		assert.match(toolResultText(harness, "g-1"), /^<blueprint_build_finished>[\s\S]*\ngenerate done$/);
	});

	test('"tools" changes nothing when the resume restores no worktree or builds no blueprint (#4748)', async () => {
		const kept = await recordedProject("", false);
		const inPlace = ready(await prepareSessionResume(kept, options("tools")));
		assert.equal(blueprintBuildPending(inPlace.sessionManager.getSessionId()), false);
		assert.notEqual(inPlace.blueprintContext, BLUEPRINT_BUILDING_CONTEXT);
		assert.deepEqual(ran(), []);

		const manager = await recordedProject("", true, "other");
		const skipped = ready(await prepareSessionResume(manager, { ...options("tools"), blueprints: "skip" }));
		assert.equal(blueprintBuildPending(skipped.sessionManager.getSessionId()), false);
		assert.equal(skipped.blueprintContext, undefined);
		assert.deepEqual(contexts(skipped.sessionManager), []);
		assert.deepEqual(ran(), []);
	});
});

describe("the blueprint barrier (#4748)", () => {
	test("the built-in tools that wait for the build are the ones the settings guide names (#4748)", () => {
		assert.deepEqual([...BLUEPRINT_GATED_TOOLS].sort(), [
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"powershell",
			"read",
			"search",
			"write",
		]);
	});

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
		const host = await hostSharingBuild("shared-session");
		const recorded: ResumeTimings[] = [];
		holdToolsUntilOwnerBuilt(sandbox.path("host"), host.pid!, "shared-session", async (timings) => {
			recorded.push(timings);
		});
		let report: string | undefined | null = null;
		const waiting = awaitBlueprintReady("shared-session").then((value) => {
			report = value;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(report, null, "the engine waits while the host builds");
		host.stdin.write("host built\n");
		await waiting;
		assert.equal(report, "host built");
		assert.deepEqual(recorded, [HANDED_OVER_TIMINGS], "the engine records the timings the host handed over");
	});

	test("an engine that starts after its host's build settled still gets the report (#4748)", async () => {
		const host = await hostSharingBuild("settled-session");
		host.stdin.write("built before the engine\n");
		await new Promise((resolve) => setTimeout(resolve, 500));
		holdToolsUntilOwnerBuilt(sandbox.path("host"), host.pid!, "settled-session");
		assert.equal(blueprintBuildPending("settled-session"), true);
		assert.equal(await awaitBlueprintReady("settled-session"), "built before the engine");
	});

	test("the engine's tools are released without a report when its host exits during the build (#4748)", async () => {
		const host = await hostSharingBuild("orphaned-session");
		holdToolsUntilOwnerBuilt(sandbox.path("host"), host.pid!, "orphaned-session");
		assert.equal(blueprintBuildPending("orphaned-session"), true);
		const exited = new Promise((resolve) => host.once("exit", resolve));
		host.kill("SIGKILL");
		await exited;
		assert.equal(await awaitBlueprintReady("orphaned-session"), undefined);
	});

	test("a wait for a build that a later resume of the session replaced gets no report (#4748)", async () => {
		const first = Promise.withResolvers<string | undefined>();
		holdToolsUntilBuilt("replaced-session", first.promise);
		const waiting = awaitBlueprintReady("replaced-session");
		holdToolsUntilBuilt("replaced-session", new Promise(() => {}));
		first.resolve("first build");
		assert.equal(await waiting, undefined);
		assert.equal(blueprintBuildPending("replaced-session"), true);
	});

	test("an engine whose host shared no build holds nothing (#4748)", () => {
		holdToolsUntilOwnerBuilt(sandbox.path("host"), process.pid, "unshared-session");
		assert.equal(blueprintBuildPending("unshared-session"), false);
	});
});

test("the report of an overlapped build says whether it finished cleanly, with its warnings and context (#4748)", () => {
	const outcome = (status: BlueprintBuildOutcome["status"]): BlueprintBuildOutcome => ({
		status,
		kind: "full",
		layers: [],
		failures: [],
		warnings: [],
		removed: [],
	});
	assert.equal(
		blueprintBuildReport({ outcome: outcome("success"), notices: [], layers: [], context: "<blueprint_context/>" }),
		"<blueprint_build_finished>\nThe environment build of this resumed session has finished.\n</blueprint_build_finished>\n<blueprint_context/>",
	);
	assert.equal(
		blueprintBuildReport({ outcome: undefined, notices: [], layers: [], context: undefined }),
		"<blueprint_build_finished>\nThe environment build of this resumed session has finished.\n</blueprint_build_finished>",
	);
	const problems = "The environment build of this resumed session has finished with problems:";
	assert.match(
		blueprintBuildReport({ outcome: outcome("partial"), notices: [], layers: [], context: undefined }),
		new RegExp(problems),
	);
	assert.match(
		blueprintBuildReport({ outcome: outcome("failed"), notices: [], layers: [], context: undefined }),
		new RegExp(problems),
	);
	assert.equal(
		blueprintBuildReport({
			outcome: outcome("success"),
			notices: [{ type: "warning", message: "Blueprint x: deprecated." }],
			layers: [],
			context: undefined,
		}),
		`<blueprint_build_finished>\n${problems}\n- Blueprint x: deprecated.\n</blueprint_build_finished>`,
	);
});

test('resume.waitForBlueprint defaults to "prompt" and reaches the resume options (#4748)', () => {
	const trusted = () => true;
	const defaults = sessionResumeOptions("cli", "/work", "/agent", SettingsManager.inMemory(), trusted);
	assert.equal(defaults.waitForBlueprint, "prompt");
	const overlapping = SettingsManager.inMemory({ resume: { waitForBlueprint: "tools" } });
	assert.equal(sessionResumeOptions("cli", "/work", "/agent", overlapping, trusted).waitForBlueprint, "tools");
});
