import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CtrlCSession = {
	isStreaming: boolean;
	queuedMessagesPaused: boolean;
	agent: { hasQueuedMessages: ReturnType<typeof vi.fn> };
	isBashRunning: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	abortBash: ReturnType<typeof vi.fn>;
	pauseQueuedMessages: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	abortCompaction: ReturnType<typeof vi.fn>;
	abortRetry: ReturnType<typeof vi.fn>;
};

type CtrlCHost = {
	lastSigintTime: number;
	session: CtrlCSession;
	restoreQueuedMessagesToEditor: ReturnType<typeof vi.fn>;
	clearEditor: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	manualCompactionTakeoverPending: boolean;
	readonly compactionActive: boolean;
	interruptActiveOperation: () => boolean;
};

const handleCtrlC = Reflect.get(InteractiveMode.prototype, "handleCtrlC") as (this: CtrlCHost) => void;
const handleSigintSignal = Reflect.get(InteractiveMode.prototype, "handleSigintSignal") as (
	this: CtrlCHost & { handleCtrlC: () => void },
) => void;
const interruptActiveOperation = Reflect.get(InteractiveMode.prototype, "interruptActiveOperation") as (
	this: CtrlCHost,
) => boolean;
const setupKeyHandlers = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (this: object) => void;

function createHost(sessionOverrides: Partial<CtrlCSession> = {}): CtrlCHost {
	const host: CtrlCHost = {
		get compactionActive() {
			return this.session.isCompacting || this.manualCompactionTakeoverPending;
		},
		lastSigintTime: 0,
		session: {
			isStreaming: false,
			queuedMessagesPaused: false,
			agent: { hasQueuedMessages: vi.fn(() => false) },
			isBashRunning: false,
			isCompacting: false,
			isRetrying: false,
			abortBash: vi.fn(),
			pauseQueuedMessages: vi.fn(),
			abort: vi.fn().mockResolvedValue(undefined),
			abortCompaction: vi.fn(),
			abortRetry: vi.fn(),
			...sessionOverrides,
		},
		manualCompactionTakeoverPending: false,
		restoreQueuedMessagesToEditor: vi.fn(),
		clearEditor: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		showError: vi.fn(),
		interruptActiveOperation: () => false,
	};
	// Wire the real interrupt helper so handleCtrlC exercises it end-to-end.
	host.interruptActiveOperation = () => interruptActiveOperation.call(host);
	return host;
}

describe("InteractiveMode Ctrl+C", () => {
	test("aborts streaming and does not clear or exit", () => {
		const host = createHost({ isStreaming: true });
		host.lastSigintTime = Date.now();

		handleCtrlC.call(host);

		expect(host.session.pauseQueuedMessages).toHaveBeenCalledTimes(1);
		expect(host.session.abort).toHaveBeenCalledTimes(1);
		expect(host.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
		expect(host.clearEditor).not.toHaveBeenCalled();
		expect(host.shutdown).not.toHaveBeenCalled();
		// Double-press window is reset so a follow-up Ctrl+C cannot exit.
		expect(host.lastSigintTime).toBe(0);
	});

	test("holds a queued continuation in the idle gap before it starts", () => {
		const host = createHost({ agent: { hasQueuedMessages: vi.fn(() => true) } });

		handleCtrlC.call(host);

		expect(host.session.pauseQueuedMessages).toHaveBeenCalledTimes(1);
		expect(host.session.abort).toHaveBeenCalledTimes(1);
		expect(host.clearEditor).not.toHaveBeenCalled();
	});

	test("aborts a running bash command", () => {
		const host = createHost({ isBashRunning: true });
		handleCtrlC.call(host);
		expect(host.session.abortBash).toHaveBeenCalledTimes(1);
		expect(host.clearEditor).not.toHaveBeenCalled();
	});

	test("aborts an active compaction", () => {
		const host = createHost({ isCompacting: true });
		handleCtrlC.call(host);
		expect(host.session.abortCompaction).toHaveBeenCalledTimes(1);
		expect(host.clearEditor).not.toHaveBeenCalled();
	});

	test("aborts the active response while a manual-compaction handoff is pending", () => {
		const host = createHost({ isStreaming: true });
		host.manualCompactionTakeoverPending = true;
		handleCtrlC.call(host);
		expect(host.session.pauseQueuedMessages).toHaveBeenCalledTimes(1);
		expect(host.session.abort).toHaveBeenCalledTimes(1);
		expect(host.session.abortCompaction).not.toHaveBeenCalled();
		expect(host.clearEditor).not.toHaveBeenCalled();
	});

	test("aborts an auto-retry countdown", () => {
		const host = createHost({ isRetrying: true });
		handleCtrlC.call(host);
		expect(host.session.abortRetry).toHaveBeenCalledTimes(1);
		expect(host.clearEditor).not.toHaveBeenCalled();
	});

	test("clears editor when idle, exits on quick double press", () => {
		const host = createHost();

		handleCtrlC.call(host);
		expect(host.clearEditor).toHaveBeenCalledTimes(1);
		expect(host.shutdown).not.toHaveBeenCalled();

		handleCtrlC.call(host);
		expect(host.shutdown).toHaveBeenCalledTimes(1);
	});

	test("reports an abort rejection without leaving an unhandled fire-and-forget promise", async () => {
		const abortError = new Error("abort settlement failed");
		const host = createHost({
			isStreaming: true,
			abort: vi.fn().mockRejectedValue(abortError),
		});

		handleCtrlC.call(host);
		await Promise.resolve();
		await Promise.resolve();

		expect(host.showError).toHaveBeenCalledWith(abortError.message);
	});
	test("Escape reports the same abort rejection instead of leaking it", async () => {
		const abortError = new Error("Escape abort settlement failed");
		const showError = vi.fn();
		const editor: {
			onEscape?: () => void;
			onAction(action: string, handler: () => void): void;
			getText(): string;
			setText(text: string): void;
		} = { onAction() {}, getText: () => "", setText() {} };
		const host = {
			session: {
				...createHost().session,
				isStreaming: true,
				abort: vi.fn().mockRejectedValue(abortError),
			},
			runtimeHost: {},
			ui: { addInputListener: () => () => {}, requestRender() {}, hasOverlay: () => false },
			keybindings: { matches: () => false },
			defaultEditor: editor,
			editor,
			editorContainer: { children: [editor] },
			blockingInlineCustomUiDepth: 0,
			settingsManager: { getDoubleEscapeAction: () => "none" },
			isBashMode: false,
			lastEscapeTime: 0,
			restoreQueuedMessagesToEditor: vi.fn(),
			showError,
			tuiInputSubscriptions: new Set(),
			addTuiInputListener: InteractiveMode.prototype.addTuiInputListener,
		};
		setupKeyHandlers.call(host);

		editor.onEscape?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(showError).toHaveBeenCalledWith(abortError.message);
	});

	test("after interruption settles, idle clear and quick-exit remain reachable without releasing the hold", () => {
		const host = createHost({ isStreaming: true });

		handleCtrlC.call(host);
		expect(host.session.pauseQueuedMessages).toHaveBeenCalledTimes(1);
		expect(host.session.abort).toHaveBeenCalledTimes(1);

		host.session.isStreaming = false;
		host.session.queuedMessagesPaused = true;
		handleCtrlC.call(host);
		expect(host.session.pauseQueuedMessages).toHaveBeenCalledTimes(1);
		expect(host.session.abort).toHaveBeenCalledTimes(1);
		expect(host.clearEditor).toHaveBeenCalledTimes(1);
		expect(host.shutdown).not.toHaveBeenCalled();

		handleCtrlC.call(host);
		expect(host.shutdown).toHaveBeenCalledTimes(1);
		expect(host.session.queuedMessagesPaused).toBe(true);
	});
});

describe("InteractiveMode SIGINT signals (#4096)", () => {
	const descriptors = {
		isTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
		isRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
	};
	function stdinRaw(raw: boolean): void {
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: raw });
	}
	function restoreStdin(): void {
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (descriptor) Object.defineProperty(process.stdin, key, descriptor);
			else Reflect.deleteProperty(process.stdin, key);
		}
	}
	function signalHost(sessionOverrides: Partial<CtrlCSession> = {}) {
		const host = createHost(sessionOverrides);
		return Object.assign(host, { handleCtrlC: () => handleCtrlC.call(host) });
	}

	test("in raw mode, signals never clear the editor or exit an idle session, however many arrive", () => {
		stdinRaw(true);
		try {
			const host = signalHost();
			for (let index = 0; index < 4; index++) handleSigintSignal.call(host);
			expect(host.clearEditor).not.toHaveBeenCalled();
			expect(host.shutdown).not.toHaveBeenCalled();
		} finally {
			restoreStdin();
		}
	});

	test("in raw mode, a signal still interrupts running work, as the key does", () => {
		stdinRaw(true);
		try {
			const host = signalHost({ isStreaming: true });
			host.lastSigintTime = Date.now();
			handleSigintSignal.call(host);
			expect(host.session.abort).toHaveBeenCalledTimes(1);
			expect(host.shutdown).not.toHaveBeenCalled();
			expect(host.lastSigintTime).toBe(0);
		} finally {
			restoreStdin();
		}
	});

	test("a stray signal between two key presses doesn't turn the first press into an exit", () => {
		stdinRaw(true);
		try {
			const host = signalHost();
			handleCtrlC.call(host);
			handleSigintSignal.call(host);
			expect(host.shutdown).not.toHaveBeenCalled();
			expect(host.clearEditor).toHaveBeenCalledTimes(1);
		} finally {
			restoreStdin();
		}
	});

	test("outside raw mode a signal is the terminal's Ctrl+C and keeps the double-press exit", () => {
		stdinRaw(false);
		try {
			const host = signalHost();
			handleSigintSignal.call(host);
			handleSigintSignal.call(host);
			expect(host.clearEditor).toHaveBeenCalledTimes(1);
			expect(host.shutdown).toHaveBeenCalledTimes(1);
		} finally {
			restoreStdin();
		}
	});
});
