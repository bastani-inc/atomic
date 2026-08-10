import {
	type Component,
	Container,
	type ScrollViewScrollbar,
	type Terminal,
	Text,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import { ENV_OFFLINE } from "../../src/config.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

export class RecordingTerminal implements Terminal {
	columns = 100;
	rows = 24;
	kittyProtocolActive = true;
	startCount = 0;
	stopCount = 0;
	cursorVisible = true;
	readonly writes: string[] = [];
	private onInput: ((data: string) => void) | undefined;
	private onResize: (() => void) | undefined;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		this.onInput = onInput;
		this.onResize = onResize;
	}

	stop(): void {
		this.stopCount += 1;
		this.onInput = undefined;
		this.onResize = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {
		this.cursorVisible = false;
	}

	showCursor(): void {
		this.cursorVisible = true;
	}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	input(data: string): void {
		this.onInput?.(data);
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.onResize?.();
	}
}

export interface LayoutBox {
	component: Component;
	rect: { x: number; y: number; width: number; height: number };
	children?: LayoutBox[];
}

export interface LayoutFrame {
	root: LayoutBox & { children: LayoutBox[] };
	lines: string[];
}

export function getLayoutFrame(tui: TuiAltScreen): LayoutFrame {
	const frame = Reflect.get(tui, "currentLayout") as LayoutFrame | undefined;
	if (!frame) throw new Error("fullscreen layout did not render");
	return frame;
}

export interface ProductionFullscreenOptions {
	columns?: number;
	rows?: number;
	transcriptLines?: number;
	fullscreenScrollbar?: ScrollViewScrollbar;
}

export interface ProductionFullscreenContext {
	context: InteractiveMode;
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
	initPromise: Promise<void>;
	resolveTheme: () => void;
	restoreOffline: () => void;
}

/**
 * Build the production init tree without constructing a session. The init call
 * pauses at the theme boundary so tests can inspect the mounted layout before
 * later startup work reaches session and resource services.
 */
export function createProductionFullscreenContext(
	options: ProductionFullscreenOptions = {},
): ProductionFullscreenContext {
	initTheme("dark");

	// The real init starts fd/rg readiness after first paint; keep this fixture network-free.
	const previousOffline = process.env[ENV_OFFLINE];
	process.env[ENV_OFFLINE] = "1";
	let offlineRestored = false;
	const restoreOffline = (): void => {
		if (offlineRestored) return;
		offlineRestored = true;
		if (previousOffline === undefined) {
			delete process.env[ENV_OFFLINE];
		} else {
			process.env[ENV_OFFLINE] = previousOffline;
		}
	};

	const terminal = new RecordingTerminal();
	terminal.columns = options.columns ?? terminal.columns;
	terminal.rows = options.rows ?? terminal.rows;
	const tui = new TuiAltScreen(terminal);
	const headerContainer = new Container();
	const documentContainer = new Container();
	for (let index = 1; index <= (options.transcriptLines ?? 20); index += 1) {
		documentContainer.addChild(new Text(`transcript line ${index}`, 0, 0));
	}
	const chatContainer = new Container();
	const pendingMessagesContainer = new Container();
	const statusContainer = new Container();
	const widgetContainerAbove = new Container();
	const widgetContainerBelow = new Container();
	const usageMeter = new Text("usage", 0, 0);
	const editor = new Text("editor", 0, 0);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const footer = new Text("footer", 0, 0);
	const footerContainer = new Container();
	footerContainer.addChild(footer);

	let releaseTheme!: () => void;
	const themeReady = new Promise<void>((resolve) => {
		releaseTheme = resolve;
	});

	const session = {
		scopedModels: [],
		modelRuntime: { getAvailableSnapshot: () => [] },
		settingsManager: { getFullscreenScrollbar: () => options.fullscreenScrollbar ?? "auto" },
	};
	const context = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: false,
		ui: tui,
		runtimeHost: { session, services: { agentDir: "/tmp" } },
		options: { deferredExtensionLoad: true, verbose: true },
		deferredStartupPending: true,
		headerContainer,
		documentContainer,
		chatContainer,
		pendingMessagesContainer,
		statusContainer,
		widgetContainerAbove,
		widgetContainerBelow,
		usageMeter,
		editorContainer,
		editor,
		defaultEditor: editor,
		footerContainer,
		footer,
		footerDataProvider: {
			onBranchChange: () => {},
			setAvailableProviderCount: () => {},
		},
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),
		pendingUserInputs: [],
		startupReplayInputs: [],
		registerSignalHandlers: () => {},
		setupKeyHandlers: () => {},
		setupEditorSubmitHandler: () => {},
		setupAutocompleteProvider: () => {},
		applyRuntimeSettings: () => {},
		subscribeToAgent: () => {},
		updateEditorBorderColor: () => {},
		updateTerminalTitle: () => {},
		attachStartupNoticesContainer: () => {},
		renderInitialMessages: () => {},
		themeController: { applyFromSettings: () => themeReady },
	});

	const init = (
		InteractiveMode.prototype as unknown as {
			init(this: InteractiveMode): Promise<void>;
		}
	).init;
	const initPromise = init.call(context);

	return { context, tui, terminal, initPromise, resolveTheme: releaseTheme, restoreOffline };
}
