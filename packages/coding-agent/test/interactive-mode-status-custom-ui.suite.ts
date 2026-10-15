import assert from "node:assert/strict";
import { type Component, Container, type Focusable, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { HostCustomUiStateListener } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { isOverlayMounted } from "../src/modes/interactive/interactive-tui.js";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.js";

class RecordingFocusable implements Component, Focusable {
	focused = false;
	readonly inputs: string[] = [];

	constructor(private readonly label: string) {}

	render(): string[] {
		return [this.label];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("InteractiveMode.showExtensionCustom host custom UI state", () => {
	function createCustomUiHostFixture() {
		const fakeThis: any = {
			editor: {
				getText: vi.fn(() => "draft"),
				setText: vi.fn(),
			},
			editorContainer: {
				clear: vi.fn(),
				addChild: vi.fn(),
			},
			keybindings: {},
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
			blockingInlineCustomUiDepth: 0,
			deferredInlineCustomUiFocusDepth: 0,
			pendingInlineCustomUiFocus: undefined,
			hostCustomUiStateListeners: new Set(),
		};
		Object.setPrototypeOf(fakeThis, (InteractiveMode as any).prototype);
		return fakeThis;
	}

	test("runs the custom UI factory synchronously before returning", async () => {
		const fakeThis = createCustomUiHostFixture();
		let returned = false;
		let factoryCalled = false;
		const component = {
			render: () => [],
			invalidate: vi.fn(),
			dispose: vi.fn(),
		};

		const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
			fakeThis,
			(_tui: unknown, _theme: unknown, _keybindings: unknown, done: (result: string) => void) => {
				expect(returned).toBe(false);
				factoryCalled = true;
				done("done");
				return component;
			},
		);
		returned = true;

		expect(factoryCalled).toBe(true);
		await expect(promise).resolves.toBe("done");
	});

	test("does not invoke the custom UI factory or notify host state listeners when the signal is already aborted", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const controller = new AbortController();
		const failure = new Error("already aborted");
		let factoryCalled = false;
		controller.abort(failure);

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(
				fakeThis,
				() => {
					factoryCalled = true;
					return { render: () => [], invalidate: vi.fn() };
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(failure);

		expect(factoryCalled).toBe(false);
		expect(states).toEqual([]);
		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
	});

	test("immediate abort after custom() returns cannot run a deferred factory", async () => {
		const fakeThis = createCustomUiHostFixture();
		const controller = new AbortController();
		const failure = new Error("aborted after return");
		let factoryCalls = 0;
		const component = {
			render: () => [],
			invalidate: vi.fn(),
			dispose: vi.fn(),
		};

		const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
			fakeThis,
			() => {
				factoryCalls++;
				return component;
			},
			{ signal: controller.signal },
		);
		expect(factoryCalls).toBe(1);

		controller.abort(failure);
		await expect(promise).rejects.toBe(failure);
		await Promise.resolve();

		expect(factoryCalls).toBe(1);
		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
	});

	test("releases host state when a non-overlay custom UI factory throws synchronously", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const failure = new Error("factory failed synchronously");

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, () => {
				expect(fakeThis.getHostCustomUiState()).toMatchObject({
					blockingInlineCustomUiActive: true,
					blockingInlineCustomUiDepth: 1,
				});
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
		expect(states).toEqual([
			{ blockingInlineCustomUiActive: true, blockingInlineCustomUiDepth: 1 },
			{ blockingInlineCustomUiActive: false, blockingInlineCustomUiDepth: 0 },
		]);
	});

	test("releases host state when a non-overlay custom UI factory rejects asynchronously", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const failure = new Error("factory rejected asynchronously");

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, () => {
				expect(fakeThis.getHostCustomUiState()).toMatchObject({
					blockingInlineCustomUiActive: true,
					blockingInlineCustomUiDepth: 1,
				});
				return Promise.reject(failure);
			}),
		).rejects.toBe(failure);

		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
		expect(states).toEqual([
			{ blockingInlineCustomUiActive: true, blockingInlineCustomUiDepth: 1 },
			{ blockingInlineCustomUiActive: false, blockingInlineCustomUiDepth: 0 },
		]);
	});
});

type OverlayHost = {
	editor: RecordingFocusable & { getText(): string; setText(text: string): void };
	editorContainer: Container;
	keybindings: KeybindingsManager;
	ui: TuiMainScreen;
	blockingInlineCustomUiDepth: number;
	deferredInlineCustomUiFocusDepth: number;
	pendingInlineCustomUiFocus: undefined;
	hostCustomUiStateListeners: Set<HostCustomUiStateListener>;
	showExtensionCustom: InteractiveMode["showExtensionCustom"];
};

describe("InteractiveMode.showExtensionCustom stacked overlays", () => {
	test.each([
		{ lowerKind: "capturing", nonCapturing: false },
		{ lowerKind: "non-capturing", nonCapturing: true },
	])("closing a lower $lowerKind overlay removes its own overlay, not the topmost one", async ({ nonCapturing }) => {
		const terminal = new RecordingTerminal();
		const ui = new TuiMainScreen(terminal);
		const editorContainer = new Container();
		const editor = new RecordingFocusable("EDITOR");
		const lower = new RecordingFocusable("LOWER");
		const upper = new RecordingFocusable("UPPER");
		const fakeThis: OverlayHost = {
			editor: Object.assign(editor, { getText: () => "", setText: () => {} }),
			editorContainer,
			keybindings: new KeybindingsManager(),
			ui,
			blockingInlineCustomUiDepth: 0,
			deferredInlineCustomUiFocusDepth: 0,
			pendingInlineCustomUiFocus: undefined,
			hostCustomUiStateListeners: new Set<HostCustomUiStateListener>(),
			showExtensionCustom: InteractiveMode.prototype.showExtensionCustom,
		};
		Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
		const showOverlay = (
			component: RecordingFocusable,
			overlayOptions?: { nonCapturing?: boolean },
		): { promise: Promise<string>; done: (result: string) => void } => {
			let done: ((result: string) => void) | undefined;
			const promise = fakeThis.showExtensionCustom<string>(
				(_tui, _theme, _keybindings, close) => {
					done = close;
					return component;
				},
				{ overlay: true, overlayOptions },
			);
			if (!done) throw new Error("custom UI factory did not run synchronously");
			return { promise, done };
		};
		const flush = async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			ui.renderNow();
		};

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		ui.start();
		try {
			const lowerMount = showOverlay(lower, { nonCapturing });
			await flush();
			const upperMount = showOverlay(upper);
			await flush();
			assert.equal(upper.focused, true);

			lowerMount.done("lower closed");
			assert.equal(await lowerMount.promise, "lower closed");
			await flush();

			assert.equal(isOverlayMounted(ui, lower), false);
			assert.equal(isOverlayMounted(ui, upper), true);
			assert.equal(upper.focused, true);
			terminal.input("x");
			await flush();
			assert.deepEqual(upper.inputs, ["x"]);
			assert.deepEqual(lower.inputs, []);

			upperMount.done("upper closed");
			assert.equal(await upperMount.promise, "upper closed");
			await flush();
			assert.equal(ui.hasOverlay(), false);
			assert.equal(editor.focused, true);
		} finally {
			ui.stop();
		}
	});
});
