import type { Terminal } from "@earendil-works/pi-tui";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type TestNode = {
	children?: TestNode[];
};

type InitContext = {
	isInitialized: boolean;
	registerSignalHandlers: () => void;
	ui: {
		addChild: (child: TestNode) => void;
		setFocus: (target: TestNode) => void;
		start: () => void;
		requestRender: () => void;
	};
	headerContainer: TestNode;
	documentContainer: TestNode;
	chatContainer: TestNode;
	pendingMessagesContainer: TestNode;
	statusContainer: TestNode;
	widgetContainerAbove: TestNode;
	usageMeter: TestNode;
	editorContainer: TestNode;
	footerContainer: TestNode;
	widgetContainerBelow: TestNode;
	editor: TestNode;
	renderWidgets: () => void;
	mountInteractiveTui: (tui: InitContext["ui"], components: TestNode[]) => void;
	setupKeyHandlers: () => void;
	setupEditorSubmitHandler: () => void;
	pendingUserInputs: string[];
	defaultEditor: TestNode;
	options: { startupInputCapture?: { consume: () => { text: string; submissions: string[] } } };
	startupReplayInputs: string[];
	footerDataProvider: { onBranchChange: (callback: () => void) => void };
	themeController: { applyFromSettings: () => Promise<void> };
	fullscreenLayoutRoot?: TestNode;
	transcriptScrollView?: TestNode;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	init(this: InitContext): Promise<void>;
};

test("InteractiveMode.init builds the fullscreen dock and preserves flat mount order", async () => {
	const mounted: TestNode[] = [];
	const themeReady = new Promise<void>(() => {});
	const component = (): TestNode => ({});
	const context: InitContext = {
		isInitialized: false,
		registerSignalHandlers: vi.fn(),
		ui: {
			addChild: (child) => mounted.push(child),
			setFocus: vi.fn(),
			start: vi.fn(),
			requestRender: vi.fn(),
		},
		headerContainer: component(),
		documentContainer: component(),
		chatContainer: component(),
		pendingMessagesContainer: component(),
		statusContainer: component(),
		widgetContainerAbove: component(),
		usageMeter: component(),
		editorContainer: component(),
		footerContainer: component(),
		widgetContainerBelow: component(),
		editor: component(),
		renderWidgets: vi.fn(),
		mountInteractiveTui: InteractiveMode.prototype
			.mountInteractiveTui as unknown as InitContext["mountInteractiveTui"],
		setupKeyHandlers: vi.fn(),
		setupEditorSubmitHandler: vi.fn(),
		pendingUserInputs: [],
		defaultEditor: component(),
		options: {},
		startupReplayInputs: [],
		footerDataProvider: { onBranchChange: vi.fn() },
		themeController: { applyFromSettings: vi.fn(() => themeReady) },
	};

	void interactiveModePrototype.init.call(context);
	await new Promise<void>((resolve) => setImmediate(resolve));

	const root = context.fullscreenLayoutRoot;
	const transcript = root?.children?.[0];
	const dock = root?.children?.[1];
	if (!root?.children || !transcript?.children || !dock?.children) {
		throw new Error("InteractiveMode.init did not build the fullscreen layout");
	}

	const dockChildren = [
		context.pendingMessagesContainer,
		context.statusContainer,
		context.widgetContainerAbove,
		context.usageMeter,
		context.editorContainer,
		context.footerContainer,
		context.widgetContainerBelow,
	];
	const flatMountOrder = [context.documentContainer, ...dockChildren];

	expect(root.children).toEqual([transcript, dock]);
	expect(transcript.children).toEqual([context.documentContainer]);
	expect(dock.children).toEqual(dockChildren);
	expect(mounted).toEqual(flatMountOrder);

	// Use a real regular renderer to keep the ordering assertion on the production
	// mount method rather than a test double that only records an equivalent list.
	const regularTui = new TuiMainScreen({} as Terminal);
	context.mountInteractiveTui(regularTui as unknown as InitContext["ui"], mounted);
	expect(regularTui.children).toEqual(flatMountOrder);
});
