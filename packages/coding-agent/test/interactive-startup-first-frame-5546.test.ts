import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, resetCapabilitiesCache, setCapabilities, Text, type TUI, TuiAltScreen } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { clearStartupStatus, showStartupStatus } from "../src/cli/startup-status.ts";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { refreshColorEnvironment } from "../src/modes/interactive/theme/color-utils.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

vi.mock("../src/modes/interactive-engine/extension-ui-bridge.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive-engine/extension-ui-bridge.ts")>()),
	waitForInteractiveEngineBound: vi.fn(async () => {}),
	waitForInteractiveEngineProjectTrust: vi.fn(async () => {}),
}));

vi.mock("../src/modes/interactive/interactive-initial-session-binding.ts", () => ({
	bindInitialEagerSession: vi.fn(async () => {}),
}));

vi.mock("../src/modes/interactive/interactive-model-catalog-startup.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive/interactive-model-catalog-startup.ts")>()),
	updateProviderCountFromSnapshot: vi.fn(),
}));

const COLUMNS = 60;
const ROWS = 10;
const COMPOSER = "❯ type a message";

let projectDir: string;

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	refreshColorEnvironment({ NO_COLOR: "1" });
	projectDir = mkdtempSync(join(tmpdir(), "atomic-startup-first-frame-"));
});
afterEach(() => {
	clearStartupStatus();
	refreshColorEnvironment();
	resetCapabilitiesCache();
	rmSync(projectDir, { recursive: true, force: true });
});

/** The process's terminal stream: what the renderer and the status line write goes through it, as on a real terminal. */
function terminalStream(writes: string[]) {
	return {
		isTTY: true,
		columns: COLUMNS,
		rows: ROWS,
		write: (data: string | Uint8Array) => {
			writes.push(typeof data === "string" ? data : Buffer.from(data).toString());
			return true;
		},
	};
}

/** A terminal that writes to `stream`, so a test can replay any prefix of what it wrote. */
class StreamTerminal extends VirtualTerminal {
	constructor(private readonly stream: { write(data: string): unknown }) {
		super(COLUMNS, ROWS);
	}

	override write(data: string): void {
		this.stream.write(data);
	}
}

/** What a terminal shows after `writes`. */
async function screenAfter(writes: readonly string[]): Promise<string[]> {
	const screen = new VirtualTerminal(COLUMNS, ROWS);
	for (const data of writes) screen.write(data);
	return screen.flushAndGetViewport();
}

/** The interactive mode around a real fullscreen renderer whose interface is just a composer line. */
function createMode(ui: TUI): InteractiveMode {
	const editor = { render: () => [], handleInput: vi.fn(), setText: vi.fn(), getText: () => "" };
	return {
		init: InteractiveMode.prototype.init,
		renderInitialMessages: vi.fn(),
		startSessionRecovery: vi.fn(),
		extensionDialogs: [],
		programStatus: { report: vi.fn(), setBlocked: vi.fn() },
		runtimeHost: {},
		session: { getToolStatusAsync: () => ({ missing: [] }) },
		keybindings: KeybindingsManager.create(projectDir),
		isInitialized: false,
		isShuttingDown: false,
		deferredStartupPending: false,
		registerSignalHandlers: vi.fn(),
		ui,
		headerContainer: new Container(),
		documentContainer: new Container(),
		chatContainer: new Container(),
		pendingMessagesContainer: new Container(),
		statusContainer: new Container(),
		widgetContainerAbove: new Container(),
		usageMeter: new Container(),
		editorContainer: new Container(),
		footerContainer: new Container(),
		widgetContainerBelow: new Container(),
		editor,
		defaultEditor: editor,
		startupNoticesContainer: new Container(),
		renderWidgets: vi.fn(),
		mountInteractiveTui: (tui: TUI) => tui.addChild(new Text(COMPOSER, 0, 0)),
		setupKeyHandlers: vi.fn(),
		setupEditorSubmitHandler: vi.fn(),
		pendingUserInputs: [],
		startupReplayInputs: [],
		footerDataProvider: { onBranchChange: vi.fn() },
		themeController: { applyFromSettings: vi.fn(async () => {}) },
		settingsManager: {
			getFullscreenScrollbar: () => "auto",
			getQuietStartup: () => true,
			isProjectTrusted: () => true,
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => [],
			getLeafId: () => null,
			getCwd: () => projectDir,
		},
		getStartupIdentityText: () => "Atomic v0.0.0",
		shouldShowStartupHeader: () => false,
		showFullscreenModelScopeNotice: () => {},
		ensureManagedToolsReady: vi.fn(async () => {}),
		attachStartupNoticesContainer: vi.fn(),
		renderSessionEntries: vi.fn(),
		options: {},
	} as unknown as InteractiveMode;
}

test("the interface's first frame replaces the startup status line in one write, so the screen is never blank (#5546)", async () => {
	const writes: string[] = [];
	const stream = terminalStream(writes);
	showStartupStatus(stream, { streams: [], console: {} });
	const ui = new TuiAltScreen(new StreamTerminal(stream));
	try {
		// The line is a row of its own, below the row the cursor was on.
		assert.ok((await screenAfter(writes)).includes("Starting Atomic…"));

		const init = createMode(ui).init();
		// Every write the terminal could show on its own: on a busy machine, or a runtime that writes each call at once,
		// a write that erased the line or switched screens before the frame was drawn left the screen blank (#5546).
		const handedOver = writes.slice(1);
		assert.equal(handedOver.length, 1, JSON.stringify(handedOver.map((data) => data.slice(0, 60))));
		const screen = await screenAfter(writes);
		assert.ok(
			screen.some((row) => row.includes(COMPOSER)),
			`expected the first frame, the screen was:\n${screen.join("\n")}`,
		);
		assert.ok(!screen.some((row) => row.includes("Starting")), screen.join("\n"));
		await init;
	} finally {
		ui.stop();
	}
});
