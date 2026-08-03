import { describe, expect, it, vi } from "vitest";
import { COMPACTION_ALREADY_IN_PROGRESS_WARNING } from "../src/modes/interactive/interactive-bash-compact.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CompactGuardContext = {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: { addToHistory?: (text: string) => void; setText: (text: string) => void; getText: () => string };
	ui: { requestRender: () => void };
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		compact: () => Promise<unknown>;
		prompt: (text: string) => Promise<void>;
	};
	sessionManager: { getEntries: () => Array<{ type: string }> };
	statusContainer: { clear: () => void };
	loadingAnimation: undefined;
	deferredStartupPending: boolean;
	compactionQueuedMessages: string[];
	queueCompactionMessage: (text: string, mode: string) => void;
	isExtensionCommand: (text: string) => boolean;
	handleCompactCommand: () => Promise<void>;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	flushPendingBashComponents: () => void;
	handleBashCommand: () => Promise<void>;
	ensureDeferredStartupComplete: () => Promise<void>;
	updateEditorBorderColor: () => void;
	renderDeferredUserInput: (text: string) => void;
	advanceStartupInputReplay: (text: string) => void;
	isBashMode: boolean;
	pendingUserInputs: string[];
	startupReplayInputs: string[];
	startupReplayActiveInput?: string;
	onInputCallback?: (text: string) => void;
	options: Record<string, never>;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: CompactGuardContext): void;
	handleCompactCommand(this: CompactGuardContext): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createContext(overrides: Partial<CompactGuardContext> = {}): CompactGuardContext {
	return {
		defaultEditor: {},
		editor: { addToHistory: vi.fn(), setText: vi.fn(), getText: vi.fn(() => "") },
		ui: { requestRender: vi.fn() },
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			compact: vi.fn(async () => ({})),
			prompt: vi.fn(async () => {}),
		},
		sessionManager: { getEntries: () => [{ type: "message" }, { type: "message" }, { type: "message" }] },
		statusContainer: { clear: vi.fn() },
		loadingAnimation: undefined,
		deferredStartupPending: false,
		compactionQueuedMessages: [],
		queueCompactionMessage: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		handleCompactCommand: vi.fn(async () => {}),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		handleBashCommand: vi.fn(async () => {}),
		ensureDeferredStartupComplete: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		renderDeferredUserInput: vi.fn(),
		advanceStartupInputReplay: vi.fn(),
		isBashMode: false,
		pendingUserInputs: [],
		startupReplayInputs: [],
		options: {},
		...overrides,
	};
}

describe("/compact while a compaction is already running", () => {
	it("warns and neither starts nor queues another compaction", async () => {
		const context = createContext();
		context.session.isCompacting = true;
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/compact");

		expect(context.showWarning).toHaveBeenCalledWith(COMPACTION_ALREADY_IN_PROGRESS_WARNING);
		expect(context.handleCompactCommand).not.toHaveBeenCalled();
		expect(context.session.compact).not.toHaveBeenCalled();
		expect(context.queueCompactionMessage).not.toHaveBeenCalled();
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("still queues ordinary text submitted during a compaction", async () => {
		const context = createContext();
		context.session.isCompacting = true;
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("keep working on the refactor");

		expect(context.queueCompactionMessage).toHaveBeenCalledWith("keep working on the refactor", "steer");
		expect(context.showWarning).not.toHaveBeenCalledWith(COMPACTION_ALREADY_IN_PROGRESS_WARNING);
	});

	it("runs the compaction normally when nothing is in flight", async () => {
		const context = createContext();
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/compact");

		expect(context.handleCompactCommand).toHaveBeenCalledTimes(1);
		expect(context.queueCompactionMessage).not.toHaveBeenCalled();
	});

	it("guards handleCompactCommand() itself before touching UI state", async () => {
		const context = createContext();
		context.session.isCompacting = true;

		await prototype.handleCompactCommand.call(context);

		expect(context.showWarning).toHaveBeenCalledWith(COMPACTION_ALREADY_IN_PROGRESS_WARNING);
		expect(context.session.compact).not.toHaveBeenCalled();
		expect(context.statusContainer.clear).not.toHaveBeenCalled();
	});

	it("still compacts through handleCompactCommand() when idle", async () => {
		const context = createContext();

		await prototype.handleCompactCommand.call(context);

		expect(context.session.compact).toHaveBeenCalledTimes(1);
		expect(context.showWarning).not.toHaveBeenCalled();
	});
});
