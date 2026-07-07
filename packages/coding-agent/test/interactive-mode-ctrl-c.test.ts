import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CtrlCSession = {
	isStreaming: boolean;
	isBashRunning: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	abortBash: ReturnType<typeof vi.fn>;
	abortCompaction: ReturnType<typeof vi.fn>;
	abortRetry: ReturnType<typeof vi.fn>;
};

type CtrlCHost = {
	lastSigintTime: number;
	session: CtrlCSession;
	restoreQueuedMessagesToEditor: ReturnType<typeof vi.fn>;
	clearEditor: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
	interruptActiveOperation: () => boolean;
};

const handleCtrlC = Reflect.get(InteractiveMode.prototype, "handleCtrlC") as (this: CtrlCHost) => void;
const interruptActiveOperation = Reflect.get(
	InteractiveMode.prototype,
	"interruptActiveOperation",
) as (this: CtrlCHost) => boolean;

function createHost(sessionOverrides: Partial<CtrlCSession> = {}): CtrlCHost {
	const host: CtrlCHost = {
		lastSigintTime: 0,
		session: {
			isStreaming: false,
			isBashRunning: false,
			isCompacting: false,
			isRetrying: false,
			abortBash: vi.fn(),
			abortCompaction: vi.fn(),
			abortRetry: vi.fn(),
			...sessionOverrides,
		},
		restoreQueuedMessagesToEditor: vi.fn(),
		clearEditor: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
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

		expect(host.restoreQueuedMessagesToEditor).toHaveBeenCalledWith({ abort: true });
		expect(host.clearEditor).not.toHaveBeenCalled();
		expect(host.shutdown).not.toHaveBeenCalled();
		// Double-press window is reset so a follow-up Ctrl+C cannot exit.
		expect(host.lastSigintTime).toBe(0);
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

	test("does not exit on the Ctrl+C immediately following an interrupt", () => {
		const host = createHost({ isStreaming: true });

		// First press interrupts the stream and resets the exit window.
		handleCtrlC.call(host);
		expect(host.restoreQueuedMessagesToEditor).toHaveBeenCalledTimes(1);

		// Stream has now stopped; the next press must clear, not exit.
		host.session.isStreaming = false;
		handleCtrlC.call(host);
		expect(host.clearEditor).toHaveBeenCalledTimes(1);
		expect(host.shutdown).not.toHaveBeenCalled();
	});
});
