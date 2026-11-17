import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences, type TUI } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	dismissedAgentPanelItems,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import { AGENT_PANEL_DROP_MS } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.ts";
import {
	MainComposerKeyOverlay,
	mainComposerHintSegments,
	mainComposerKeys,
} from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-editor-actions.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-dialogs.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const DOWN = "\x1b[B";

beforeAll(() => {
	initTheme("dark", false);
});

afterEach(() => {
	vi.useRealTimers();
});

function createHarness(options: { working?: boolean; initialItems?: AgentPanelItem[] } = {}) {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const items: AgentPanelItem[] = [...(options.initialItems ?? [])];
	let notifySource = () => {};
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => items,
		subscribe: (listener) => {
			notifySource = listener;
			return () => {};
		},
	});
	let working = options.working ?? false;
	let navigationActive = false;
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
		modelRuntime: {
			isUsingOAuth: () => false,
		},
		extensionRunner: {
			getAgentPanelSourceHub: () => hub,
		},
	};
	const listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
	const customs: Array<unknown> = [];
	const tui = { requestRender: () => {}, hasOverlay: () => false } as unknown as TUI & {
		hasOverlay(): boolean;
		setFocus(component: unknown): void;
	};
	tui.setFocus = () => {};
	const defaultEditor = new CustomEditor(tui, getEditorTheme(), keybindings);
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
		() => navigationActive,
		undefined,
		() => mainComposerHintSegments(keybindings),
	);
	const mode = Object.assign(Object.create(InteractiveModeBase.prototype), {
		addTuiInputListener: (listener: (data: string) => { consume?: boolean } | undefined) => {
			listeners.push(listener);
			return () => {};
		},
		activeSelectorDispose: undefined,
		autocompleteProvider: undefined,
		chatContainer: { children: [], clear: () => {}, addChild: () => {}, removeChild: () => {} },
		defaultEditor,
		editor: defaultEditor,
		editorComponentFactory: undefined,
		editorContainer: {
			children: [defaultEditor as unknown],
			clear() {
				this.children.length = 0;
			},
			addChild(child: unknown) {
				this.children.push(child);
			},
		},
		extensionDialogs: [],
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),
		footer,
		footerDataProvider: { setExtensionStatus: () => {} },
		isBashMode: false,
		keybindings,
		loadingAnimation: undefined,
		navigationInlineCustomUiDepth: 0,
		runtimeHost: { session },
		statusContainer: { clear: () => {}, addChild: () => {} },
		createExtensionUIContext: () => ({
			getChatRenderSettings: () => ({}),
			getFooterDataProvider: () => footerData,
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			notify: () => {},
		}),
		disposeActiveSelector: () => {},
		showExtensionCustom: (factory: unknown) => {
			customs.push(factory);
			return new Promise<void>(() => {});
		},
		showStatus: () => {},
		showWarning: () => {},
		ui: tui,
	}) as InteractiveModeBase;

	const setItems = (next: AgentPanelItem[]) => {
		items.length = 0;
		items.push(...next);
		notifySource();
	};
	const setWorking = (next: boolean) => {
		working = next;
	};
	const pressDown = (): boolean => {
		for (const listener of listeners) {
			if (listener(DOWN)?.consume) return true;
		}
		return false;
	};

	const setNavigationActive = (active: boolean) => {
		navigationActive = active;
	};
	return {
		mode,
		session,
		keybindings,
		footer,
		defaultEditor,
		customs,
		setItems,
		setWorking,
		setNavigationActive,
		pressDown,
	};
}

describe("main composer agent panel hints and custom editor Down routing (#5239)", () => {
	for (const width of [80, 160]) {
		test(`footer and key overlay track live agentPanelItems count at ${width} columns and match live Down handling (#5239)`, async () => {
			const { mode, session, keybindings, footer, defaultEditor, customs, setItems, setWorking, pressDown } =
				createHarness({ working: true });
			await mode.setupKeyHandlers();

			assert.deepEqual(mainComposerHintSegments(keybindings, session), ["? keys"]);
			const emptyFooter = stripTerminalSequences(footer.render(width)[0] ?? "");
			assert.equal(emptyFooter, "esc to interrupt · ? keys");
			assert.equal(pressDown(), false);
			assert.equal(customs.length, 0);

			setItems([{ id: "ext:t1", kind: "agent", state: "running", name: "debugger", task: "#5220 spawn lock" }]);
			assert.deepEqual(mainComposerHintSegments(keybindings, session), ["↓ 1 agent", "? keys"]);
			const oneAgentFooter = stripTerminalSequences(footer.render(width)[0] ?? "");
			assert.equal(oneAgentFooter, "esc to interrupt · ↓ 1 agent · ? keys");

			setItems([
				{ id: "ext:t1", kind: "agent", state: "running", name: "debugger", task: "#5220 spawn lock" },
				{ id: "ext:t2", kind: "agent", state: "running", name: "worker", task: "fix shipping batches" },
				{
					id: "run:r1",
					kind: "workflow",
					state: "running",
					name: "ralph",
					task: "stage implement",
					progress: { done: 3, total: 5 },
				},
			]);
			const threeAgentsWorking = stripTerminalSequences(footer.render(width)[0] ?? "");
			assert.equal(threeAgentsWorking, "esc to interrupt · ↓ 3 agents · ? keys");

			setWorking(false);
			const threeAgentsIdle = stripTerminalSequences(footer.render(width)[0] ?? "");
			assert.ok(threeAgentsIdle.endsWith(" · ↓ 3 agents · ? keys"), threeAgentsIdle);

			defaultEditor.handleInput("?");
			assert.equal(customs.length, 1);
			const overlayFactory = customs[0] as (
				tui: unknown,
				theme: unknown,
				kb: KeybindingsManager,
				done: () => void,
			) => MainComposerKeyOverlay;
			const overlay = overlayFactory({}, {}, keybindings, () => {});
			const overlayLines = overlay.render(width).map(stripTerminalSequences).join("\n");
			assert.match(overlayLines, /↓\s+agents, on an empty prompt/u);

			assert.equal(pressDown(), true);
			assert.equal(customs.length, 2);

			dismissedAgentPanelItems(session).add("ext:t1");
			dismissedAgentPanelItems(session).add("ext:t2");
			assert.equal(stripTerminalSequences(footer.render(width)[0] ?? "").endsWith(" · ↓ 1 agent · ? keys"), true);

			dismissedAgentPanelItems(session).add("run:r1");
			assert.equal(stripTerminalSequences(footer.render(width)[0] ?? "").includes("↓"), false);
			assert.equal(pressDown(), false);
		});
	}

	test("finished rows that age out of the panel drop from the footer count so the hint never advertises a dead key (#5239)", async () => {
		const start = Date.UTC(2026, 10, 17, 1, 0, 0);
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		const { mode, footer, pressDown } = createHarness({
			working: false,
			initialItems: [
				{ id: "ext:done", kind: "agent", state: "done", name: "worker", task: "picker clamp", endedAt: start },
			],
		});
		await mode.setupKeyHandlers();

		assert.ok(stripTerminalSequences(footer.render(160)[0] ?? "").endsWith(" · ↓ 1 agent · ? keys"));
		assert.equal(pressDown(), true);

		vi.setSystemTime(start + AGENT_PANEL_DROP_MS + 1);
		const expiredLine = stripTerminalSequences(footer.render(160)[0] ?? "");
		assert.equal(expiredLine.includes("↓"), false, expiredLine);
		assert.equal(pressDown(), false);
	});

	test("navigation sheets hide main-chat hints while retaining the idle model footer (#5224)", async () => {
		const { mode, footer, setWorking, setNavigationActive } = createHarness({
			initialItems: [{ id: "run:waiting", kind: "workflow", state: "input", name: "review", task: "Approve?" }],
		});
		await mode.setupKeyHandlers();
		assert.match(stripTerminalSequences(footer.render(160)[0] ?? ""), /↓ 1 agent · 1 needs input · \? keys$/u);
		setNavigationActive(true);
		const sheetFooter = footer.render(160).map(stripTerminalSequences).join("\n");
		assert.match(sheetFooter, /claude-sonnet-4-5/u);
		assert.doesNotMatch(sheetFooter, /↓|needs input|\? keys/u);
		setWorking(true);
		assert.deepEqual(footer.render(160), []);
		setNavigationActive(false);
		assert.equal(
			stripTerminalSequences(footer.render(160)[0] ?? ""),
			"esc to interrupt · ↓ 1 agent · 1 needs input · ? keys",
		);
	});

	test("unbound app.agents.focus is omitted from the footer and overlay even when items exist (#5239)", () => {
		const unboundFocus = {
			matches: () => false,
			getKeys: (action: string) => (action === "app.agents.focus" ? [] : action === "app.keys.help" ? ["?"] : []),
		};
		assert.deepEqual(mainComposerHintSegments(unboundFocus, { agentRows: 3 }), ["? keys"]);
		const overlay = new MainComposerKeyOverlay(
			unboundFocus,
			() => ({ working: false, agentRows: 3 }),
			() => {},
		);
		const text = overlay.render(80).map(stripTerminalSequences).join("\n");
		assert.doesNotMatch(text, /agents, on an empty prompt/u);
		const keys = mainComposerKeys({ working: false, agentRows: 3 });
		assert.ok(keys.some((entry) => entry.action === "app.agents.focus"));
	});

	test("isolated engine footer uses explicit counts including offscreen pending questions when host session items are empty (#5224)", async () => {
		const { mode, footer } = createHarness({ working: true });
		const runtime = Object.assign(Object.create(IsolatedInteractiveRuntime.prototype), {
			panelCounts: { total: 17, needsInput: 2 },
		});
		Object.assign(mode, { runtimeHost: runtime });
		Object.defineProperty(runtime, "session", { value: createHarness({ working: true }).session });
		await mode.setupKeyHandlers();
		assert.equal(
			stripTerminalSequences(footer.render(80)[0] ?? ""),
			"esc to interrupt · ↓ 17 agents · 2 needs input · ? keys",
		);
		runtime.panelCounts = { total: 0, needsInput: 0 };
		assert.equal(stripTerminalSequences(footer.render(80)[0] ?? ""), "esc to interrupt · ? keys");
	});

	test("Down arrow is left to a custom editor with an empty getText() and opens the agent panel again once the default editor is restored (#5239)", async () => {
		const { mode, keybindings, customs, pressDown } = createHarness({
			initialItems: [{ id: "run:1", kind: "workflow", state: "running", name: "other-flow", task: "stage one" }],
		});
		await mode.setupKeyHandlers();

		let inlineReceivedDown = 0;
		mode.setCustomEditorComponent((tui, _theme, kb) => {
			const inline = new CustomEditor(tui, getEditorTheme(), kb);
			const originalHandleInput = inline.handleInput.bind(inline);
			inline.handleInput = (data: string) => {
				if (data === DOWN) inlineReceivedDown += 1;
				return originalHandleInput(data);
			};
			return inline as never;
		});

		assert.equal(mode.editor.getText(), "");
		assert.equal(pressDown(), false);
		assert.equal(customs.length, 0);
		mode.editor.handleInput(DOWN);
		assert.equal(inlineReceivedDown, 1);

		const directInline = new CustomEditor({ requestRender: () => {} } as TUI, getEditorTheme(), keybindings);
		mode.editorComponentFactory = undefined;
		mode.editor = directInline as never;
		mode.editorContainer.clear();
		mode.editorContainer.addChild(directInline as never);
		assert.equal(mode.editor.getText(), "");
		assert.equal(pressDown(), false);
		assert.equal(customs.length, 0);

		mode.setCustomEditorComponent(undefined);
		assert.equal(mode.editor, mode.defaultEditor);
		assert.equal(mode.editor.getText(), "");
		assert.equal(pressDown(), true);
		assert.equal(customs.length, 1);
	});
});
