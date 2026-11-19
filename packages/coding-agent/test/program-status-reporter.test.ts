import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import type { ProgramStatus, Terminal } from "@bastani/atomic-tui";
import { test } from "vitest";
import { APP_NAME } from "../src/config.js";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.js";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../src/modes/interactive-engine/protocol.js";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.js";

function setup() {
	const reports: ProgramStatus[] = [];
	const terminal = {
		setProgramStatus: (status: ProgramStatus) => {
			reports.push(status);
		},
	} as Terminal;
	const session = { name: "Session" };
	const reporter = new ProgramStatusReporter(
		() => terminal,
		() => session.name,
	);
	const send = (...events: AgentSessionEvent[]) => {
		for (const event of events) reporter.handleEvent(event);
	};
	const last = () => reports.at(-1);
	return { reports, session, reporter, send, last };
}

function assistantEnd(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AgentSessionEvent {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "secret output" }],
		stopReason,
		errorMessage,
	} as AssistantMessage;
	return { type: "message_end", message };
}
const settled: AgentSessionEvent = { type: "agent_settled", aborted: false };
function compactionEnd(
	reason: "manual" | "threshold" | "overflow",
	errorMessage?: string,
	aborted = false,
): AgentSessionEvent {
	return { type: "compaction_end", reason, result: undefined, aborted, willRetry: false, errorMessage };
}

test("reports working until settled, preserving only the final outcome (#10607)", () => {
	const { reporter, send, last, reports } = setup();
	reporter.report();
	assert.deepEqual(last(), { state: "idle", app: APP_NAME });
	send({ type: "agent_start" }, assistantEnd("error", "retry"), assistantEnd("stop"));
	assert.deepEqual(last(), { state: "working", message: "Session", app: APP_NAME });
	send(settled);
	assert.deepEqual(last(), { state: "done", message: "Session", app: APP_NAME });
	send({ type: "agent_start" }, assistantEnd("error", "Invalid key\nstack"), settled);
	assert.deepEqual(last(), { state: "error", message: "Invalid key", app: APP_NAME });
	send({ type: "agent_start" }, assistantEnd("stop"), { type: "agent_settled", aborted: true });
	assert.deepEqual(last(), { state: "idle", app: APP_NAME });
	assert.ok(!JSON.stringify(reports).includes("secret output"));
});

test("reports recovery and manual compaction outcomes (#10607)", () => {
	const { send, last } = setup();
	send({ type: "agent_start" }, { type: "compaction_start", reason: "overflow" });
	assert.deepEqual(last(), { state: "working", message: "Compacting context", app: APP_NAME });
	send(compactionEnd("overflow", "Failed\nstack"), settled);
	assert.deepEqual(last(), { state: "error", message: "Failed", app: APP_NAME });
	send({ type: "agent_start" }, compactionEnd("threshold", "Failed"), assistantEnd("stop"), settled);
	assert.equal(last()?.state, "done");
	send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual"));
	assert.equal(last()?.state, "done");
	send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual", "No model"));
	assert.equal(last()?.state, "error");
	send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual", undefined, true));
	assert.equal(last()?.state, "idle");
});

test("reports the newest dialog and restores the underlying settled state (#10607)", () => {
	const { reporter, send, last } = setup();
	send({ type: "agent_start" });
	reporter.setBlocked("extension-dialog", { kind: "permission", message: "Allow bash?" });
	reporter.setBlocked("login", { kind: "auth", message: "Log in" });
	assert.equal(last()?.kind, "auth");
	reporter.setBlocked("login", undefined);
	send(assistantEnd("stop"), settled);
	assert.equal(last()?.kind, "permission");
	reporter.setBlocked("extension-dialog", { kind: "question", message: "Choose" });
	assert.equal(last()?.kind, "question");
	reporter.setBlocked("extension-dialog", undefined);
	assert.equal(last()?.state, "done");
});

test("deduplicates reports and follows session rename and replacement (#10607)", () => {
	const { reporter, reports, session, send, last } = setup();
	send({ type: "agent_start" }, assistantEnd("toolUse"));
	reporter.report();
	assert.equal(reports.length, 1);
	session.name = "Renamed";
	send({ type: "session_info_changed", name: "Renamed" });
	assert.equal(last()?.message, "Renamed");
	reporter.reset();
	assert.equal(last()?.state, "idle");
});

test("never writes OSC 133 marks from fullscreen overlay transcripts to the terminal (#3739)", () => {
	initTheme("dark");
	const terminal = new RecordingTerminal();
	terminal.columns = 60;
	terminal.rows = 12;
	const transcript = [
		"\x1b]133;A\x07full-width bel",
		"\x1b]133;B\x1b\\full-width st",
		"stage \x1b]133;C\x07mid-line bel",
		"stage \x1b]133;A;cl=m\x1b\\mid-line st\x1b]133;C;exit=0\x1b\\",
	];
	const overlay = { render: () => transcript, invalidate() {} };
	const tui = createFullscreenTui({ terminal, showHardwareCursor: false, logDirectory: tmpdir() });
	try {
		tui.start();
		const fullWidth = tui.showOverlay(overlay, { anchor: "top-left", width: "100%" });
		const centered = tui.showOverlay(overlay, { anchor: "bottom-center", width: "50%" });
		tui.renderNow(true);
		const written = terminal.writes.join("");
		assert.equal(written.includes("\x1b]133;"), false, "an OSC 133 mark reached the terminal");
		for (const text of ["full-width bel", "full-width st", "mid-line bel", "mid-line st"]) {
			assert.equal(written.includes(text), true, `${text} must still be painted`);
		}
		centered.hide();
		fullWidth.hide();
	} finally {
		tui.stop();
	}
});

for (const forwarded of [false, true]) {
	test(`reports main-chat questionnaires through ${forwarded ? "engine" : "local"} delivery (#3616)`, async () => {
		const { reporter, send, last } = setup();
		const runner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			{} as never,
		);
		let answer!: () => void;
		const pending = new Promise<void>((resolve) => {
			answer = resolve;
		});
		runner.setUIContext(
			{
				...noOpUIContext,
				custom: async () => {
					await pending;
					return undefined as never;
				},
			},
			"tui",
		);
		runner.setUIPromptObserver((event) => {
			if (!forwarded) return reporter.handleUIPrompt(event);
			const message = parseInteractiveEngineMessage(
				serializeInteractiveEngineFrame({ type: "engine_ui_prompt", event }),
			);
			assert.equal(message?.type, "engine_ui_prompt");
			if (message?.type !== "engine_ui_prompt") assert.fail("Expected prompt lifecycle");
			reporter.handleUIPrompt(message.event);
		});
		send({ type: "agent_start" });
		const ui = runner.getUIContext();
		const navigation = ui.custom(
			() => {
				throw new Error("Unused factory");
			},
			{ purpose: "navigation" },
		);
		assert.equal(last()?.state, "working", "navigation does not block");
		const question = ui.custom(() => {
			throw new Error("Unused factory");
		});
		assert.deepEqual(reporter.currentStatus(), {
			state: "blocked",
			kind: "question",
			message: "Waiting for input",
		});
		answer();
		await Promise.all([navigation, question]);
		assert.equal(last()?.state, "working");
		send({ type: "agent_settled", aborted: true });
		assert.equal(last()?.state, "idle");
		runner.setUIPromptObserver(undefined);
	});
}

test("preserves prompt fields through the engine protocol and rejects invalid values (#3616)", () => {
	for (const type of ["ui_prompt_start", "ui_prompt_end"] as const) {
		for (const kind of ["custom", "confirm", "select", "input", "editor"] as const) {
			for (const reason of ["ui_prompt", "project_trust"] as const) {
				for (const title of [undefined, "Prompt title"]) {
					const event = { type, kind, reason, ...(title === undefined ? {} : { title }) };
					const message = { type: "engine_ui_prompt", event } as const;
					assert.deepEqual(parseInteractiveEngineMessage(serializeInteractiveEngineFrame(message)), message);
				}
			}
		}
	}
	const event = { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" };
	for (const invalid of [{ type: "open" }, { reason: "login" }, { kind: "question" }, { title: null }, { title: 1 }]) {
		assert.equal(
			parseInteractiveEngineMessage(JSON.stringify({ type: "engine_ui_prompt", event: { ...event, ...invalid } })),
			undefined,
		);
	}
});

test("prompt cleanup preserves other blocked sources and ignores trust prompts (#3616)", () => {
	const { reporter, send, last } = setup();
	send({ type: "agent_start" });
	reporter.handleUIPrompt({ type: "ui_prompt_start", reason: "project_trust", kind: "select" });
	assert.equal(last()?.state, "working");
	reporter.setBlocked("login", { kind: "auth", message: "Log in" });
	reporter.handleUIPrompt({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
	assert.equal(last()?.kind, "question");
	reporter.handleUIPrompt(undefined);
	assert.equal(last()?.kind, "auth");
	reporter.setBlocked("login", undefined);
	assert.equal(last()?.state, "working");
});
