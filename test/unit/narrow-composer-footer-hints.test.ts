import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setKeybindings, stripHintMarkers, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelRow } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { agentPanelKeys } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.js";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import {
	type AttachedComposerStyle,
	applyAttachedComposer,
} from "../../packages/coding-agent/src/modes/interactive/components/input-label.js";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.js";
import {
	type NavKey,
	type NavKeyStyle,
	renderNavHintLine,
} from "../../packages/coding-agent/src/modes/interactive/components/nav-keys.js";
import { taskChatKeys } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { createStopAllChord } from "../../packages/coding-agent/src/modes/interactive/interactive-stop-all.js";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { moduleDir, readText } from "../helpers/runtime.js";
import { makeTestTui } from "../support/fake-tui.js";

const plainStyle: NavKeyStyle = {
	// Hint lines are compared as the terminal shows them, without their zero-width click markers.
	dim: (text) => stripHintMarkers(text),
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
};

const composerStyle: AttachedComposerStyle = {
	accent: (text) => `<accent>${text}</accent>`,
	text: (text) => `<text>${text}</text>`,
	dim: (text) => `<dim>${text}</dim>`,
};

const docsRoot = resolve(moduleDir(import.meta.url), "../../packages/coding-agent/docs");

beforeAll(() => {
	initTheme("dark", false);
});

describe("attached placeholder spacing, narrow footer/hint priority, stop-all copy, and docs (#5239)", () => {
	test("applyAttachedComposer places the placeholder immediately after the real CustomEditor cursor cell without a third space (#5239)", () => {
		const keybindings = new KeybindingsManager();
		const editor = new CustomEditor(makeTestTui(24), getEditorTheme(), keybindings, { paddingX: 0 });
		for (const focused of [true, false]) {
			editor.focused = focused;
			const rawLines = editor.render(80);
			const decorated = applyAttachedComposer(
				composerStyle,
				"debugger · #5220 spawn lock · 18m",
				"Message debugger…",
				rawLines,
			);
			const expectedMarker = focused ? "\x1b_pi:c\x07" : "";
			assert.equal(decorated[1], `❯ ${expectedMarker}\x1b_pi:fc\x07 \x1b_pi:/fc\x07<dim>Message debugger…</dim>`);
			const plain = stripTerminalSequences(decorated[1] ?? "").replace(/<\/?dim>/gu, "");
			assert.equal(plain, "❯  Message debugger…");
			assert.doesNotMatch(plain, /^❯ {3}/u);
		}
	});

	test("main footer at narrow widths drops lower-priority hint segments whole and preserves ↓ N agents and ? keys (#5239)", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		for (const working of [true, false]) {
			const session = {
				get isStreaming() {
					return working;
				},
				isCompacting: false,
				isRetrying: false,
				isBashRunning: false,
				state: {
					model: { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true, contextWindow: 200_000 },
					thinkingLevel: "medium",
				},
				sessionManager: {
					getCwd: () => "/workspace/atomic-project",
					getSessionName: () => "shipping fix-first",
				},
				modelRuntime: { isUsingOAuth: () => false },
			};
			const footerData = {
				getGitBranch: () => "main",
				getExtensionStatuses: () => new Map<string, string>(),
				getAvailableProviderCount: () => 1,
				onBranchChange: () => () => {},
			};
			const footer = new FooterComponent(
				session as never,
				footerData as never,
				undefined,
				() => false,
				undefined,
				() => mainComposerHintSegments(keybindings, { agentRows: 3, needsInput: 1 }),
			);
			for (const width of [30, 40, 50, 60, 80, 160]) {
				const line = stripTerminalSequences(footer.render(width)[0] ?? "");
				assert.ok(visibleWidth(line) <= width, `w=${width} working=${working}: ${line}`);
				assert.match(line, /↓ 3 agents/u, `w=${width} working=${working}: ${line}`);
				assert.match(line, /\? keys$/u, `w=${width} working=${working}: ${line}`);
				assert.doesNotMatch(line, /1 nee\.\.\.|↓ 3 agen\.\.\.|esc to in\.\.\./u, line);
			}
			assert.equal(
				stripTerminalSequences(footer.render(40)[0] ?? ""),
				working ? "esc to interrupt · ↓ 3 agents · ? keys" : "claude-sonnet-4... · ↓ 3 agents · ? keys",
			);
			assert.equal(stripTerminalSequences(footer.render(30)[0] ?? ""), "↓ 3 agents · ? keys");
		}
	});

	test("renderNavHintLine keeps one separator style and preserves way-out and ? keys on panel, /tasks, and attached chats (#5239)", () => {
		const keys = new KeybindingsManager();
		const runningRow: AgentPanelRow = {
			id: "task:1",
			kind: "agent",
			state: "running",
			name: "debugger",
			task: "spawn lock",
		};
		const panel60 = renderNavHintLine(agentPanelKeys(runningRow, keys), 60, plainStyle, keys);
		assert.equal(panel60, "  ↑↓ select · esc/← back to prompt · ? keys");
		assert.ok(visibleWidth(panel60) <= 60);

		const panel40 = renderNavHintLine(agentPanelKeys(runningRow, keys), 40, plainStyle, keys);
		assert.equal(panel40, "  esc/← back to prompt · ? keys");
		assert.ok(visibleWidth(panel40) <= 40);

		const tasksDismissKeys: readonly NavKey[] = [
			{ keys: "↑↓", label: "select" },
			{ action: "app.list.peek", label: "peek" },
			{ keys: "enter/→", label: "open" },
			{ action: "app.list.stop", label: "dismiss" },
			{ keys: "/", label: "filter" },
			{ keys: "esc/←", label: "close" },
			{ action: "app.keys.help", label: "keys" },
		];
		const tasks80Dismiss = renderNavHintLine(tasksDismissKeys, 80, plainStyle, keys, 2, { compact: true });
		assert.equal(tasks80Dismiss, "  ↑↓ select · space peek · enter/→ open · x dismiss · esc/← close · ? keys");
		assert.doesNotMatch(tasks80Dismiss, /\S·\S/u);

		const tasks60 = renderNavHintLine(tasksDismissKeys, 60, plainStyle, keys, 2, { compact: true });
		assert.match(tasks60, /esc\/← close · \? keys$/u);
		assert.doesNotMatch(tasks60, /\S·\S/u);
		assert.ok(visibleWidth(tasks60) <= 60);

		const tasks40 = renderNavHintLine(tasksDismissKeys, 40, plainStyle, keys, 2, { compact: true });
		assert.equal(tasks40, "  ↑↓ select · esc/← close · ? keys");
		assert.ok(visibleWidth(tasks40) <= 40);

		const peekCardKeys: readonly NavKey[] = [
			{ keys: "↑↓", label: "select" },
			{ keys: "space/esc/←", label: "close" },
			{ keys: "enter/→", label: "open" },
			{ action: "app.list.stop", label: "dismiss" },
			{ keys: "/", label: "filter" },
			{ action: "app.keys.help", label: "keys" },
		];
		const peek40 = renderNavHintLine(peekCardKeys, 40, plainStyle, keys, 2, { compact: true });
		assert.match(peek40, /space\/esc\/← close/u);
		assert.match(peek40, /\? keys$/u);
		assert.ok(visibleWidth(peek40) <= 40);

		const attached40 = renderNavHintLine(taskChatKeys("main chat", true, false, true), 40, plainStyle, keys);
		assert.equal(attached40, "  ← main chat · esc interrupt · ? keys");
		assert.ok(visibleWidth(attached40) <= 40);

		const stage40 = renderNavHintLine(taskChatKeys("graph", true, false, true), 40, plainStyle, keys);
		assert.equal(stage40, "  ← graph · esc interrupt · ? keys");
		assert.ok(visibleWidth(stage40) <= 40);
	});

	test("Ctrl+X Ctrl+K pending notice fits within 60 and 80 columns without mid-phrase truncation (#5239)", () => {
		const statuses: string[] = [];
		const listener = createStopAllChord({
			keybindings: new KeybindingsManager(),
			chordAllowed: () => true,
			stopAll: async () => ({ agents: 0, shells: 0, workflowRuns: 0, failures: [] }),
			showStatus: (message) => statuses.push(message),
			showWarning: () => {},
			clearStatus: () => {},
		});
		listener("\x18");
		listener("\x0b");
		assert.deepEqual(statuses, ["Press ctrl+x ctrl+k again within 3s to stop all"]);
		assert.ok(visibleWidth(statuses[0]!) <= 60);
	});

	test("subagents and workflows docs reflect agent-panel rows, current workflow commands, and clean prose (#5239)", async () => {
		const subagentsRef = await readText(resolve(docsRoot, "subagents/reference.md"));
		assert.doesNotMatch(subagentsRef, /below-prompt background counts/u);
		assert.match(subagentsRef, /agent panel/iu);

		const operationsDoc = await readText(resolve(docsRoot, "workflows/operations.md"));
		assert.doesNotMatch(operationsDoc, /named by id, name or unique prefix by its id, name or unique id prefix/u);
		assert.doesNotMatch(operationsDoc, /stops a run as `\/workflow quit` does/u);

		const builtinsDoc = await readText(resolve(docsRoot, "workflows/builtins.md"));
		assert.doesNotMatch(builtinsDoc, /Use `\/workflow status` for full details/u);
	});
});
