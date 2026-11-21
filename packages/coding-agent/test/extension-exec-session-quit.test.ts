import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../src/core/agent-session-persistent-custom-messages.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ExecResult } from "../src/core/exec.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { quitAsInteractiveApp } from "../src/core/interactive-quit.js";
import { createHarness, type Harness } from "./suite/harness.js";

/**
 * Longer than any session close here takes once nothing holds it, however loaded the machine, and far shorter than the
 * minute a close waits for work that never settles.
 */
const CLOSE_BOUND_MS = 20_000;
/** Longer than a killed process takes to be gone, however loaded the machine. */
const GONE_MS = 5_000;
const POLL_MS = 20;
/** How long the shutdown handlers of a bounded quit are waited for here. */
const HANDLER_LIMIT_MS = 200;

/** A command that records its pid in `file` and then runs until it is killed; with `deaf`, it ignores SIGTERM. */
function holdingCommand(file: string, deaf = false): [string, string[]] {
	const script = `${deaf ? 'process.on("SIGTERM", () => {});' : ""}require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
	return [process.execPath, ["-e", script, file]];
}

async function waitForFile(file: string): Promise<RecordedProcess> {
	const deadline = Date.now() + CLOSE_BOUND_MS;
	while (!existsSync(file) || readFileSync(file, "utf8") === "") {
		assert.ok(Date.now() < deadline, `${file} was never written`);
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	return recordProcess(Number(readFileSync(file, "utf8")));
}

/**
 * Quits the session as the interactive app does, failing when that takes longer than {@link CLOSE_BOUND_MS}. With
 * `handlerLimitMs`, the shutdown handlers are waited for at most that long, as in the in-process host.
 */
async function quitWithinBound(harness: Harness, handlerLimitMs?: number): Promise<void> {
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.session.sessionManager.getCwd(), agentDir: harness.tempDir } as AgentSessionServices,
		(async () => {
			throw new Error("a quit replaces no session");
		}) as CreateAgentSessionRuntimeFactory,
	);
	quitAsInteractiveApp(runtime, handlerLimitMs === undefined ? {} : { handlerLimitMs });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<"stuck">((resolve) => {
		timer = setTimeout(() => resolve("stuck"), CLOSE_BOUND_MS);
	});
	try {
		const closed = await Promise.race([runtime.dispose().then(() => "closed" as const), bound]);
		assert.equal(closed, "closed", "the quit waited for the session's work");
	} finally {
		clearTimeout(timer);
	}
}

interface QuitRecord {
	shutdownRan: boolean;
	/** The command's result as the shutdown handler saw it. */
	resultAtShutdown: ExecResult | undefined;
}

for (const deaf of [false, true]) {
	test(`a pi.exec command still running when the interactive app quits ends with it${deaf ? ", also one that ignores SIGTERM," : ""} and session_shutdown runs`, async () => {
		let harness: Harness | undefined;
		const record: QuitRecord = { shutdownRan: false, resultAtShutdown: undefined };
		let child: RecordedProcess | undefined;
		try {
			let started = "";
			let result: ExecResult | undefined;
			harness = await createHarness({
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.on("session_start", () => {
							const [command, args] = holdingCommand(started, deaf);
							void pi.exec(command, args).then((value) => {
								result = value;
							});
						});
						pi.on("session_shutdown", () => {
							record.shutdownRan = true;
							record.resultAtShutdown = result;
						});
					},
				],
			});
			started = join(harness.tempDir, "command.pid");
			await harness.session.bindExtensions({});
			child = await waitForFile(started);

			await quitWithinBound(harness);

			assert.equal(record.shutdownRan, true, "session_shutdown ran");
			assert.equal(
				record.resultAtShutdown?.killed,
				true,
				"the command had ended, ended by Atomic, before the handler ran",
			);
			if (process.platform !== "win32") assert.equal(record.resultAtShutdown?.code, deaf ? 137 : 143);
			assert.equal(await waitUntilGone(child, GONE_MS), true, "the command's process is gone");
		} finally {
			if (child) await signalRecordedProcess(child);
			await harness?.cleanup();
		}
	});
}

test("a pi.exec command a session_shutdown handler runs is not ended by the interactive app's quit", async () => {
	let harness: Harness | undefined;
	let child: RecordedProcess | undefined;
	try {
		let started = "";
		let handlerResult: ExecResult | undefined;
		harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_start", () => {
						const [command, args] = holdingCommand(started);
						void pi.exec(command, args);
					});
					pi.on("session_shutdown", async () => {
						handlerResult = await pi.exec(process.execPath, [
							"-e",
							'setTimeout(() => process.stdout.write("saved"), 200)',
						]);
					});
				},
			],
		});
		started = join(harness.tempDir, "command.pid");
		await harness.session.bindExtensions({});
		child = await waitForFile(started);

		await quitWithinBound(harness);

		assert.deepEqual(
			handlerResult && { stdout: handlerResult.stdout, code: handlerResult.code, killed: handlerResult.killed },
			{ stdout: "saved", code: 0, killed: false },
		);
	} finally {
		if (child) await signalRecordedProcess(child);
		await harness?.cleanup();
	}
});

test("a pi.exec command that work started before the interactive app's quit runs once the quit began ends at once", async () => {
	let harness: Harness | undefined;
	const children: RecordedProcess[] = [];
	try {
		let first = "";
		let second = "";
		let secondOutcome: ExecResult | Error | undefined;
		let shutdownRan = false;
		harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					// An event handler is work the session's close waits for, and may still act once the quit began.
					pi.events.on("hold", async () => {
						const [command, args] = holdingCommand(first);
						await pi.exec(command, args);
						const [nextCommand, nextArgs] = holdingCommand(second);
						secondOutcome = await pi.exec(nextCommand, nextArgs).catch((error: Error) => error);
					});
					pi.on("session_start", () => {
						pi.events.emit("hold", {});
					});
					pi.on("session_shutdown", () => {
						shutdownRan = true;
					});
				},
			],
		});
		first = join(harness.tempDir, "first.pid");
		second = join(harness.tempDir, "second.pid");
		await harness.session.bindExtensions({});
		children.push(await waitForFile(first));

		await quitWithinBound(harness);

		assert.equal(shutdownRan, true, "session_shutdown ran");
		assert.ok(secondOutcome !== undefined, "the work that started the later command had settled");
		if (existsSync(second)) {
			children.push(await waitForFile(second));
			assert.equal((secondOutcome as ExecResult).killed, true, "the later command was ended");
		}
		for (const child of children)
			assert.equal(await waitUntilGone(child, GONE_MS), true, "no command outlives the quit");
	} finally {
		for (const child of children) await signalRecordedProcess(child);
		await harness?.cleanup();
	}
});

test("a quit that bounds the shutdown handlers still runs the rest of the session's close after a handler that never finishes", async () => {
	let harness: Harness | undefined;
	try {
		let handlerStarted = false;
		harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_shutdown", async () => {
						handlerStarted = true;
						await new Promise(() => {});
					});
				},
			],
		});
		await harness.session.bindExtensions({});
		// Messages held back for a turn that never starts are saved by the close, after the handlers.
		harness.session.pauseQueuedMessages();
		await harness.session.sendCustomMessages(
			[{ customType: "held-card", content: [{ type: "text", text: "kept" }], display: true, details: {} }],
			{ triggerTurn: true, persistWhenStreaming: true },
		);

		await quitWithinBound(harness, HANDLER_LIMIT_MS);

		assert.equal(handlerStarted, true, "the handler started");
		const saved = harness.session.sessionManager
			.getEntries()
			.filter(
				(entry) => entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
			);
		assert.equal(saved.length, 1, "the held message was saved after the handler stopped being waited for");
	} finally {
		await harness?.cleanup();
	}
});
