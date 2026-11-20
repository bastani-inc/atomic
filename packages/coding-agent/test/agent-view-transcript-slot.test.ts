/**
 * The single chat screen's transcript area: the viewed subagent's transcript is drawn where the main transcript
 * is, on Atomic's fullscreen renderer over a recording terminal, with the production input route. Main's own layout
 * root comes back as it was.
 */
import assert from "node:assert/strict";
import { getKeybindings, MULTI_CLICK_INTERVAL_MS, setKeybindings, Text } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { taskFixture } from "../../../test/helpers/task-projection.ts";
import { taskTranscriptEnvironment } from "../../../test/helpers/task-transcript-environment.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { heldPromptInput } from "../src/core/extensions/held-prompts.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { TaskId } from "../src/core/tasks/contracts.js";
import { ownerTaskViewSource } from "../src/core/tasks/task-view-source.js";
import { AgentViewSwitcher } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
import { openLocalAgentViewPort } from "../src/modes/interactive/agent-view/local-port.ts";
import { notifyViewed } from "../src/modes/interactive/agent-view/viewed-notices.ts";
import { dismissedTasks } from "../src/modes/interactive/components/task-dismissal.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { assistant, flush, has, liveSubagent, mainScreen, PAGE_UP } from "./helpers/agent-view-screen.ts";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function localSwitcher(ui: ReturnType<typeof mainScreen>, sub: Awaited<ReturnType<typeof liveSubagent>>) {
	const watchers = new Set<() => void>();
	const switcher = new AgentViewSwitcher(
		(taskId) =>
			openLocalAgentViewPort({
				source: sub.source,
				taskId,
				env: taskTranscriptEnvironment({ tui: ui.tui, keybindings: ui.mode.keybindings }),
				requestRender: () => ui.tui.requestRender(),
				watch: (listener) => {
					watchers.add(listener);
					return () => watchers.delete(listener);
				},
			}),
		(message) => ui.notices.push(`switcher: ${message}`),
	);
	return {
		switcher,
		panelChanged: () => {
			for (const listener of [...watchers]) listener();
		},
	};
}

describe("the viewed subagent's transcript in the main transcript area", () => {
	test("draws the subagent's live transcript above the same prompt and footer, then gives main back exactly", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(30);
		const { switcher } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		try {
			// The reader parks main above its end.
			ui.screen();
			ui.terminal.input(PAGE_UP);
			const parked = ui.screen();
			const parkedTop = ui.scroll.scrollTop;
			assert.ok(has(parked, /main line/) && !has(parked, /main line 40$/), parked.join("\n"));

			assert.equal(await switcher.view(sub.taskId), true);
			const viewing = ui.screen();
			assert.ok(has(viewing, /sub line 30$/), viewing.join("\n"));
			assert.ok(!has(viewing, /main line/), "main's transcript is not drawn while the subagent is shown");
			assert.deepEqual(viewing.slice(-2), ["❯ prompt", "footer"], "the dock stays where it was");

			// Main goes on while the subagent is shown: rows arrive below the reader's place.
			ui.document.addChild(new Text("main line 41", 0, 0));
			sub.emit({ type: "message_start", message: assistant("") } as AgentSessionEvent);
			sub.emit({
				type: "message_update",
				message: assistant("streamed while shown"),
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streamed while shown" },
			} as unknown as AgentSessionEvent);
			await flush();
			assert.ok(has(ui.screen(), /streamed while shown/), "the subagent's stream is followed live");

			assert.equal(await switcher.view(undefined), true);
			assert.equal(Reflect.get(ui.tui, "layoutRoot"), ui.root, "main's own layout root object is back");
			assert.equal(ui.scroll.scrollTop, parkedTop, "main's place is kept");
			assert.deepEqual(ui.screen(), parked, "main shows exactly what it showed before");
		} finally {
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("scroll keys and the wheel move the subagent's transcript and never main's", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(30);
		const { switcher } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		try {
			ui.screen();
			const mainTop = ui.scroll.scrollTop;
			await switcher.view(sub.taskId);
			const following = ui.screen();
			assert.ok(has(following, /sub line 30$/), following.join("\n"));
			ui.terminal.input(PAGE_UP);
			await flush();
			const paged = ui.screen();
			assert.ok(!has(paged, /sub line 30$/) && has(paged, /sub line/), paged.join("\n"));
			assert.equal(ui.scroll.scrollTop, mainTop, "PgUp did not move main");

			// Wheel turns down over the transcript area scroll it back to its end, a line a turn.
			const row = paged.findIndex((line) => /sub line/.test(line));
			for (let turn = 0; turn < 20; turn++) ui.terminal.input(`\x1b[<65;5;${row + 1}M`);
			await flush();
			assert.ok(has(ui.screen(), /sub line 30$/), ui.screen().join("\n"));
			assert.equal(ui.scroll.scrollTop, mainTop, "the wheel did not move main");
		} finally {
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("a finished subagent stays shown with its last rows; a dismissed one gives the screen back to main at once", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(5);
		const { switcher, panelChanged } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		try {
			await switcher.view(sub.taskId);
			sub.stop();
			await sub.fixture.settle();
			await flush();
			const finished = ui.screen();
			assert.equal(switcher.viewed.kind, "agent");
			assert.ok(has(finished, /sub line 5$/), finished.join("\n"));

			dismissedTasks(sub.source).add(sub.taskId);
			panelChanged();
			assert.equal(switcher.viewed.kind, "main", "the same tick");
			const back = ui.screen();
			assert.ok(has(back, /main line 40$/) && !has(back, /sub line/), back.join("\n"));
		} finally {
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("main's notices stay main's and are also drawn under the shown subagent; its own notices only there", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(5);
		const { switcher } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		try {
			await switcher.view(sub.taskId);
			ui.mode.showWarning("the engine restarted");
			ui.mode.showStatus("first status");
			ui.mode.showStatus("second status");
			notifyViewed(ui.mode, "/model sets the main conversation's model", "warning");
			const lines = ui.screen();
			const warning = lines.indexOf(" Warning: the engine restarted");
			assert.notEqual(warning, -1, lines.join("\n"));
			assert.deepEqual(lines.slice(warning + 1, warning + 4), [
				" second status",
				" Warning: /model sets the main conversation's model",
				"❯ prompt",
			]);
			assert.deepEqual(
				ui.notices,
				["main warning: the engine restarted", "main status: first status", "main status: second status"],
				"main keeps its own notices, and only those",
			);
			await switcher.view(undefined);
			assert.ok(!has(ui.screen(), /Warning:/), "the rows under the subagent leave with it");
			notifyViewed(ui.mode, "back on main", "info");
			assert.deepEqual(ui.notices.at(-1), "main status: back on main");
		} finally {
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("a question the shown subagent waits on takes the keys in the transcript area until it is answered", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(5);
		const { switcher } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		const controller = new AbortController();
		try {
			await switcher.view(sub.taskId);
			const answer = heldPromptInput.select("Deploy where?", ["staging", "production"], {
				signal: controller.signal,
				requestId: "deploy-target",
				sessionId: sub.sessionId,
			});
			await flush();
			const asking = ui.screen();
			assert.ok(has(asking, /Deploy where\?/) && has(asking, /production/), asking.join("\n"));
			assert.ok(has(asking, /sub line 5$/), "the transcript keeps its rows above the form");
			assert.equal(switcher.viewed.kind === "agent" && switcher.viewed.port.status().heldPrompt, true);
			assert.notEqual(ui.tui.getFocusedComponent(), ui.mode.editor, "the form has the keys");
			ui.terminal.input("\x1b[B");
			ui.terminal.input("\r");
			assert.equal(await answer, "production");
			await flush();
			assert.equal(ui.tui.getFocusedComponent(), ui.mode.editor, "the prompt has them back");
			assert.ok(!has(ui.screen(), /Deploy where\?/));
		} finally {
			controller.abort();
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("a click on a block of the shown transcript expands it", async () => {
		const ui = mainScreen();
		const fixture = taskFixture();
		await fixture.start("Run the build");
		const session = SessionManager.inMemory();
		await session.appendMessage({ role: "user", content: "Run the build", timestamp: 0 });
		await session.appendMessage(
			assistant("", {
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "make" } }],
				stopReason: "toolUse",
			}),
		);
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `build line ${i + 1}`).join("\n") }],
			isError: false,
			timestamp: 2,
		});
		fixture.runners[0]!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
		const source = ownerTaskViewSource(fixture.store);
		const switcher = new AgentViewSwitcher(
			(taskId: TaskId) =>
				openLocalAgentViewPort({
					source,
					taskId,
					env: taskTranscriptEnvironment({ tui: ui.tui, keybindings: ui.mode.keybindings }),
					requestRender: () => ui.tui.requestRender(),
				}),
			() => {},
		);
		const uninstall = ui.bind(switcher);
		try {
			await switcher.view(fixture.store.tasks[0]!.ref.taskId);
			const before = ui.screen();
			assert.ok(!has(before, /build line 1$/), before.join("\n"));
			const row = before.findIndex((line) => /build line 12$/.test(line));
			assert.notEqual(row, -1, before.join("\n"));
			const column = before[row]!.indexOf("build") + 1;
			ui.terminal.input(`\x1b[<0;${column};${row + 1}M`);
			ui.terminal.input(`\x1b[<0;${column};${row + 1}m`);
			await new Promise((resolve) => setTimeout(resolve, MULTI_CLICK_INTERVAL_MS + 50));
			await flush();
			assert.ok(has(ui.screen(), /build line 1$/), ui.screen().join("\n"));
		} finally {
			uninstall();
			ui.tui.stop();
			await fixture.dispose();
		}
	});
});
