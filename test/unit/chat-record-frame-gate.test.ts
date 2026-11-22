import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import type { Component } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
import { releaseStartupChatOutput } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";

beforeAll(() => initTheme("dark", false));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

/** An extension's message renderer whose component counts the frames that draw it. */
function countingNote() {
	const renders: string[] = [];
	const extension = (atomic: { registerMessageRenderer: (type: string, renderer: () => Component) => void }) =>
		atomic.registerMessageRenderer("note", () => ({
			render: () => {
				renders.push("note");
				return ["  extension note"];
			},
			invalidate() {},
		}));
	return { renders, extension };
}

/** The main-screen renderer, which the interactive mode selects for TERM=dumb. */
function regularChat(session: Harness["session"]): { mode: InteractiveMode; terminal: RecordingTerminal } {
	const host = {
		session,
		services: { agentDir: tmpdir() },
		diagnostics: [],
		setBeforeSessionInvalidate() {},
		setRebindSession() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
	const terminal = new RecordingTerminal();
	terminal.columns = 100;
	terminal.rows = 40;
	const term = process.env.TERM;
	process.env.TERM = "dumb";
	let mode: InteractiveMode;
	try {
		mode = new InteractiveMode(host, { terminal });
	} finally {
		if (term === undefined) delete process.env.TERM;
		else process.env.TERM = term;
	}
	assert.equal(mode.ui.mode, "regular");
	(mode as unknown as { isInitialized: boolean }).isInitialized = true;
	// The transcript above the editor, as init() mounts them.
	mode.mountInteractiveTui(mode.ui, [mode.documentContainer, mode.editorContainer]);
	mode.ui.setFocus(mode.editor);
	releaseStartupChatOutput(mode);
	cleanups.push(() => mode.stop());
	return { mode, terminal };
}

const screen = (terminal: RecordingTerminal) =>
	stripVTControlCharacters(terminal.writes.join(""))
		.split(/\r\n|\n/)
		.map((line) => line.trim())
		.filter(Boolean);

/** A saved session with an extension note and a saved diagnostic after it, reopened with a held diagnostic read. */
async function reopenedWithHeldDiagnostics() {
	const note = countingNote();
	const first = await createHarness({ extensionFactories: [note.extension] });
	cleanups.push(() => first.cleanup());
	first.setResponses([fauxAssistantMessage("the answer")]);
	await first.session.prompt("the question");
	await first.session.sendCustomMessage(
		{ customType: "note", display: true, content: "a note" },
		{ excludeFromContext: true },
	);
	const noteEntry = first.sessionManager.getEntries().at(-1)!;
	const saved = first.sessionManager.chatRecordScope();
	assert.ok(saved, "the session store keeps reader records");
	await saved.store.append(saved.owner, noteEntry.id, { kind: "line", level: "warning", text: "saved diagnostic" });
	const reopen = async () => {
		const manager = await SessionManager.open(
			first.sessionManager.getSessionStore(),
			first.sessionManager.getSessionId(),
		);
		const harness = await createHarness({ sessionManager: manager, extensionFactories: [note.extension] });
		cleanups.push(() => harness.cleanup());
		return harness;
	};
	// Main has no reader records to wait for.
	const main = await reopen();
	main.sessionManager.chatRecordScope = () => undefined;
	const gated = await reopen();
	const scope = gated.sessionManager.chatRecordScope();
	assert.ok(scope);
	const lookup = Promise.withResolvers<void>();
	const read = scope.store.read.bind(scope.store);
	scope.store.read = async (owner, anchors) => {
		await lookup.promise;
		return read(owner, anchors);
	};
	cleanups.push(() => lookup.resolve());
	return { note, main, gated, lookup };
}

test("a reopened main-screen chat draws its transcript at main's instant and writes saved diagnostics without replaying renderers (#5649)", async () => {
	const { note, main, gated, lookup } = await reopenedWithHeldDiagnostics();
	const before = regularChat(main.session);
	before.mode.renderInitialMessages();
	before.mode.ui.renderNow();
	const mainRenders = note.renders.length;
	assert.equal(mainRenders, 1, "main draws the extension note in its first frame");

	const after = regularChat(gated.session);
	after.mode.renderInitialMessages();
	after.mode.ui.renderNow();
	assert.equal(note.renders.length, mainRenders + 1, "the extension renderer runs at main's instant");
	assert.equal(screen(after.terminal).includes("the question"), false, "the frame waits for the read");

	lookup.resolve();
	await vi.waitFor(() => assert.ok(screen(after.terminal).includes("saved diagnostic")));
	const rows = screen(after.terminal);
	assert.ok(rows.indexOf("extension note") < rows.indexOf("saved diagnostic"));
	assert.deepEqual(
		rows.filter((row) => row !== "saved diagnostic"),
		screen(before.terminal),
		"the written frame is main's frame with the saved row added",
	);
	after.mode.ui.renderNow();
	assert.equal(note.renders.length, mainRenders + 2, "only the frames main renders draw the note");
});

test("input while saved diagnostics load is written after main's transcript frame, in main's order (#5649)", async () => {
	const { note, main, gated, lookup } = await reopenedWithHeldDiagnostics();
	const before = regularChat(main.session);
	const after = regularChat(gated.session);
	for (const { mode } of [before, after]) {
		mode.renderInitialMessages();
		mode.ui.renderNow();
	}
	for (const { mode } of [before, after]) {
		mode.editor.setText("typed while loading");
		mode.ui.renderNow();
	}
	assert.equal(note.renders.length, 4, "each chat drew the note in each of its two frames");
	assert.deepEqual(screen(after.terminal), screen(before.terminal));
	assert.equal(after.terminal.writes.join(""), before.terminal.writes.join(""), "main's bytes, in main's order");

	lookup.resolve();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(screen(after.terminal).includes("saved diagnostic"), false, "late rows wait for a later redraw");
	assert.equal(note.renders.length, 4);
});
