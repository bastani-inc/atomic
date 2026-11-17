import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import {
	type Component,
	Container,
	getKeybindings,
	setKeybindings,
	type Terminal,
	Text,
	type TUI,
	TuiMainScreen,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { HostCustomUiStateListener } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.js";
import { ShowImagesSelectorComponent } from "../src/modes/interactive/components/show-images-selector.js";
import { ThemeSelectorComponent } from "../src/modes/interactive/components/theme-selector.js";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.js";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, setTheme, type Theme } from "../src/modes/interactive/theme/theme.js";
import { fakeModelRuntime } from "./model-runtime-test-utils.js";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
}

type DialogHost = {
	extensionDialogs: { component: Component }[];
	editorContainer: Container;
	editor: Component & { getText(): string; setText(text: string): void };
	ui: TuiMainScreen;
	nextBlockingOverlayId: number;
	extensionOverlays: Set<() => void>;
	programStatus: { setBlocked: ReturnType<typeof vi.fn> };
	disposeActiveSelector: () => void;
	toggleToolOutputExpansion: () => void;
	blockingInlineCustomUiDepth: number;
	navigationInlineCustomUiDepth: number;
	deferredInlineCustomUiFocusDepth: number;
	pendingInlineCustomUiFocus: Component | undefined;
	hostCustomUiStateListeners: Set<HostCustomUiStateListener>;
	isInitialized: boolean;
	keybindings: KeybindingsManager;
	showExtensionSelector(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal },
	): Promise<string | undefined>;
	showExtensionCustom<T>(
		factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
		options?: {
			overlay?: boolean;
			signal?: AbortSignal;
			blocked?: { kind: "permission" | "question" | "auth"; message: string };
		},
	): Promise<T>;
};

function createDialogHost(): DialogHost {
	const ui = new TuiMainScreen(new FakeTerminal());
	const editorContainer = new Container();
	let editorText = "";
	const editor = Object.assign(new Text("editor"), {
		getText: () => editorText,
		setText: (text: string) => {
			editorText = text;
		},
	});
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	ui.setFocus(editor);

	const base = Object.create(InteractiveMode.prototype) as DialogHost;
	return Object.assign(base, {
		extensionDialogs: [],
		editorContainer,
		editor,
		ui,
		nextBlockingOverlayId: 0,
		extensionOverlays: new Set<() => void>(),
		programStatus: { setBlocked: vi.fn() },
		disposeActiveSelector: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
		blockingInlineCustomUiDepth: 0,
		navigationInlineCustomUiDepth: 0,
		deferredInlineCustomUiFocusDepth: 0,
		pendingInlineCustomUiFocus: undefined,
		hostCustomUiStateListeners: new Set<HostCustomUiStateListener>(),
		isInitialized: true,
		keybindings: new KeybindingsManager(),
	});
}

function testModel(): Model<Api> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("selector theme refresh (#5237)", () => {
	let previousKeybindings: ReturnType<typeof getKeybindings>;

	beforeEach(() => {
		vi.stubEnv("COLORTERM", "truecolor");
		initTheme("dark");
		previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
		vi.unstubAllEnvs();
		initTheme("dark");
	});

	it("repaints both body and frame in the new theme when an extension select is re-shown after an inline custom dialog (#5237)", async () => {
		const host = createDialogHost();
		const selectPromise = host.showExtensionSelector("Deploy target\nChoose environment", ["staging", "production"]);

		let closeOverlay: (() => void) | undefined;
		const overlayPromise = host.showExtensionCustom<void>(
			(_tui, _theme, _kb, done) => {
				closeOverlay = done;
				return new Text("status overlay");
			},
			{ overlay: true },
		);
		await vi.waitFor(() => assert.ok(closeOverlay));

		const darkLines = host.editorContainer.render(80);

		let closeCustom: ((result: string) => void) | undefined;
		const customPromise = host.showExtensionCustom<string>((_tui, _theme, _kb, done) => {
			closeCustom = done;
			return new Text("inline custom dialog");
		});
		await vi.waitFor(() => assert.ok(closeCustom));
		assert.match(host.editorContainer.render(80).join("\n"), /inline custom dialog/);

		setTheme("light");
		host.ui.invalidate();

		closeCustom?.("done");
		assert.equal(await customPromise, "done");

		const reshownLines = host.editorContainer.render(80);
		const freshLightSelector = new ExtensionSelectorComponent(
			"Deploy target\nChoose environment",
			["staging", "production"],
			() => {},
			() => {},
			{
				tui: host.ui,
				onToggleToolsExpanded: () => {},
			},
		);
		const expectedLightLines = freshLightSelector.render(80);

		assert.notDeepEqual(expectedLightLines, darkLines);
		assert.deepEqual(reshownLines, expectedLightLines);

		closeOverlay?.();
		await overlayPromise;

		assert.deepEqual(host.editorContainer.render(80), expectedLightLines);

		host.extensionDialogs[0]?.component.handleInput?.("\r");
		assert.equal(await selectPromise, "staging");
	});

	it("repaints every selector-based picker in the active theme on the next render (#5237)", () => {
		const model = testModel();
		const runtime = fakeModelRuntime({
			getAvailableSnapshot: () => [model],
			getModel: () => model,
		});
		const tui = new TuiMainScreen(new FakeTerminal());
		const buildPickers = () => [
			new ExtensionSelectorComponent(
				"Title\nSubtitle",
				["Option A", "Option B"],
				() => {},
				() => {},
			),
			new TrustSelectorComponent({
				cwd: resolve("/project"),
				savedDecision: { path: resolve("/project"), decision: true },
				projectTrusted: true,
				onSelect: () => {},
				onCancel: () => {},
			}),
			new ShowImagesSelectorComponent(
				true,
				() => {},
				() => {},
			),
			new ThemeSelectorComponent(
				"dark",
				() => {},
				() => {},
				() => {},
			),
			new ThinkingSelectorComponent(
				"medium",
				["low", "medium", "high"],
				() => {},
				() => {},
				"medium",
			),
			new OAuthSelectorComponent(
				"login",
				runtime,
				[{ id: "anthropic", name: "Anthropic", authType: "api_key" }],
				() => {},
				() => {},
			),
			new ScopedModelsSelectorComponent(
				{ allModels: [model], enabledModelIds: ["anthropic/claude-sonnet-4-5"] },
				{ onChange: () => {}, onCancel: () => {} },
			),
			new ModelSelectorComponent(
				tui,
				model,
				SettingsManager.inMemory(),
				runtime,
				[],
				() => {},
				() => {},
				undefined,
				"medium",
			),
		];

		const pickers = buildPickers();
		try {
			const darkRenders = pickers.map((picker) => picker.render(80));
			setTheme("light");
			const repaintedRenders = pickers.map((picker) => picker.render(80));
			const freshLightPickers = buildPickers();
			try {
				const freshLightRenders = freshLightPickers.map((picker) => picker.render(80));
				for (let index = 0; index < pickers.length; index++) {
					assert.notDeepEqual(repaintedRenders[index], darkRenders[index]);
					assert.deepEqual(repaintedRenders[index], freshLightRenders[index]);
				}
			} finally {
				for (const picker of freshLightPickers) {
					if ("dispose" in picker && typeof picker.dispose === "function") picker.dispose();
				}
			}
		} finally {
			for (const picker of pickers) {
				if ("dispose" in picker && typeof picker.dispose === "function") picker.dispose();
			}
		}
	});
});
