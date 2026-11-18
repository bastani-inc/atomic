import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings, type TuiMouseEvent, type TuiMouseEventResult } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { showTaskInspector } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-responses",
	provider: "openai",
	model: "fixture",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const output = (label: string) => Array.from({ length: 20 }, (_, index) => `${label} line ${index + 1}`).join("\n");

function click(x: number, y: number, width: number, height: number, clickCount = 1): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount,
	};
}

/**
 * Delivers a click as the renderer does: to `target`, then, once no second press made it a double-click, its
 * single-click action.
 */
function singleClick(
	target: { handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined },
	event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
	const result = target.handleMouse?.(event);
	result?.whenSingleClick?.();
	return result;
}

for (const width of [80, 160]) {
	test(`in an open task transcript a click on a grouped summary shows its calls and a click on any row of one of them folds them, at ${width} columns`, async () => {
		initTheme("dark");
		const keys = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const fixture = taskFixture();
		const session = SessionManager.inMemory();
		await session.appendMessage({ role: "user", content: "Inspect the shell output", timestamp: 0 });
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const emit = (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		};
		const environment = taskTranscriptEnvironment();
		const inspector = new TaskInspector(
			fixture.store,
			() => {},
			() => {},
			undefined,
			() => environment,
		);
		const height = 60;
		const screen = () => inspector.renderViewport(width, height).map((line) => stripVTControlCharacters(line));
		const rowOf = (pattern: RegExp) => {
			const row = screen().findIndex((line) => pattern.test(line));
			assert.notEqual(row, -1, `no row matches ${pattern}:\n${screen().join("\n")}`);
			return row;
		};
		const expanded = (label: string) => screen().some((line) => line.trimEnd().endsWith(`${label} line 1`));
		try {
			await fixture.start();
			fixture.runners[0].context.bindTranscript({
				getSessionId: () => session.getSessionId(),
				getEntries: () => session.getEntries(),
				getStreamingMessage: () => undefined,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			});
			inspector.handleInput("\r");
			await flush();
			inspector.handleInput("\r");
			await flush();
			emit({ type: "message_end", message: assistant("Running both commands.") });
			for (const [id, label] of [
				["one", "alpha"],
				["two", "beta"],
			] as const) {
				emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: `${label}-cmd` } });
				emit({
					type: "tool_execution_end",
					toolCallId: id,
					toolName: "bash",
					result: { content: [{ type: "text", text: output(label) }] },
					isError: false,
				});
			}
			assert.ok(!expanded("alpha"), screen().join("\n"));
			assert.ok(!expanded("beta"), screen().join("\n"));

			const summary = rowOf(/Ran 2 shell commands/);
			singleClick(inspector, click(screen()[summary]!.indexOf("Ran"), summary, width, height));
			assert.ok(expanded("alpha"), screen().join("\n"));
			assert.ok(expanded("beta"), screen().join("\n"));

			const body = rowOf(/beta line 18$/);
			const column = screen()[body]!.indexOf("beta");
			assert.equal(singleClick(inspector, click(column, body, width, height, 2)), undefined);
			assert.ok(expanded("beta"), "a double-click is a selection");

			singleClick(inspector, click(column, body, width, height));
			assert.ok(!expanded("alpha"), screen().join("\n"));
			assert.ok(!expanded("beta"), screen().join("\n"));
			assert.notEqual(
				screen().findIndex((line) => /Ran 2 shell commands/.test(line)),
				-1,
				screen().join("\n"),
			);
		} finally {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(keys);
		}
	});
}

test("a subagent chat opened from the agent panel takes a click on a block's output through its full-screen view", async () => {
	initTheme("dark");
	const keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	try {
		await fixture.start("Subagent task");
		const session = SessionManager.inMemory();
		await session.appendMessage({ role: "user", content: "Subagent task", timestamp: 1_000 });
		await session.appendMessage({
			...assistant(""),
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "child-cmd" } }],
			stopReason: "toolUse",
		});
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: output("child") }],
			isError: false,
			timestamp: 2_000,
		});
		await session.appendMessage(assistant("Done."));
		fixture.runners[0]!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		const width = 100;
		const views: string[][] = [];
		await showTaskInspector(
			{
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
				async custom<T>(factory: Parameters<Parameters<typeof showTaskInspector>[0]["custom"]>[0]): Promise<T> {
					const component = await factory(
						makeTestTui(40),
						{} as never,
						new KeybindingsManager(),
						(() => {}) as never,
					);
					await flush();
					const lines = () => component.render(width).map((line) => stripVTControlCharacters(line));
					views.push(lines());
					const shown = lines().findIndex((line) => line.trimEnd().endsWith("child line 18"));
					assert.notEqual(shown, -1, lines().join("\n"));
					const handled = component.handleMouse?.(click(lines()[shown]!.indexOf("child"), shown, width, 40));
					assert.equal(handled?.handled, true);
					assert.equal(
						lines().some((line) => line.trimEnd().endsWith("child line 1")),
						false,
						"not before it settles",
					);
					handled?.whenSingleClick?.();
					views.push(lines());
					component.handleInput?.("\x1b[D");
					component.dispose?.();
					return undefined as T;
				},
			},
			fixture.store,
			taskId,
			{ chat: true, backLabel: "main chat" },
		);
		const expanded = (view: readonly string[]) => view.some((line) => line.trimEnd().endsWith("child line 1"));
		assert.equal(expanded(views[0]!), false, views[0]!.join("\n"));
		assert.equal(expanded(views[1]!), true, views[1]!.join("\n"));
	} finally {
		await fixture.dispose();
		setKeybindings(keys);
	}
});
