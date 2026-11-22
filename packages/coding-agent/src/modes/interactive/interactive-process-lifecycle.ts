import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExtensionStackMatches } from "../../core/crash-log.ts";
import { markEventLoopShutdown } from "../../core/event-loop-monitor.ts";
import { quitAsInteractiveApp } from "../../core/interactive-quit.js";
import { killSupervisedProcessTrees } from "../../core/tasks/supervisor.js";
import { exitWithStatus } from "../../utils/process-exit-status.js";
import { isModuleLoadFailure, UpdatedInstallError, updatedInstallError } from "../../utils/updated-install.ts";
import { CONSOLE_CLOSED_EXIT_CODE, CONSOLE_CLOSED_SHUTDOWN_MS } from "../../utils/windows-console-close.js";
import {
	gracefullyStoppedEnginePids,
	onEngineConsoleClosed,
	runsInteractiveEngine,
	terminateInteractiveEngine,
} from "../interactive-engine/extension-ui-bridge.ts";
import { ENGINE_SHUTDOWN_GRACE_MS } from "../rpc/rpc-client-process.js";
import { promptHandle } from "./agent-view/agent-drafts.ts";
import {
	dequeueViewedAgent,
	followUpViewedAgent,
	interruptViewedAgent,
	leaveViewedAgent,
} from "./agent-view/viewed-submit.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { APP_TITLE, chalk, killTrackedDetachedChildren } from "./interactive-mode-deps.ts";
import { formatCrashExtensionHint, formatResumeCommand, isDeadTerminalError } from "./interactive-mode-helpers.ts";
import { pauseAndAbortInteractiveSession } from "./interactive-pause.ts";
import { restoreFailedSubmissionDraft, restoreRefusedSubmission } from "./interactive-prompt-restore.ts";
import { handOffCompactionQueue, mainSteering, showQueueRestoreFailure } from "./interactive-queueing.ts";
import { stopRendererWatch } from "./interactive-session-runtime.ts";
import { chatHistoryBuilt } from "./interactive-startup-chat-container.ts";
import { isWindowsSubshellActive, openWindowsSubshell } from "./interactive-windows-subshell.ts";
import { onWindowsSessionEnd } from "./windows-session-end.js";

/** A second Ctrl+C on an empty, idle editor within this window exits. */
const CTRL_C_EXIT_WINDOW_MS = 800;
const SHUTDOWN_INPUT_DRAIN_MAX_MS = 250;
const SHUTDOWN_INPUT_DRAIN_IDLE_MS = 50;
/** Exit status once the terminal is gone, as for a process ended by SIGHUP. */
const TERMINAL_LOST_EXIT_CODE = 129;
/**
 * Once the terminal is gone, the longest the session's shutdown may take before Atomic ends anyway: the interactive
 * engine's grace period, then its guardian's and its tree kill's windows.
 */
const TERMINAL_LOST_SHUTDOWN_MS = ENGINE_SHUTDOWN_GRACE_MS + 1_000;

/** How an interactive host is ending, beyond whether it has started to shut down. */
interface HostEnding {
	/** SIGTERM signals received. Only a repeated one ends every child at once. */
	sigterms: number;
	/** Set once the terminal is gone: the shutdown restores nothing and Atomic exits with status 129. */
	terminalLost: boolean;
	/** Set once the Windows console is closed: Atomic exits with {@link CONSOLE_CLOSED_EXIT_CODE} instead of 129. */
	consoleClosed: boolean;
	/**
	 * Set once the lost terminal's bound has run out on Windows with the close not proven: Atomic's exit is decided and
	 * waits only for the turns that read a close notice already received ({@link lostTerminalBoundEnded}). Nothing that
	 * happens in them ends Atomic another way: a shutdown that ends, an uncaught exception or a failure on the terminal's
	 * streams leaves the exit to it, as it was before the bound's exit waited at all.
	 */
	lostExitDeciding: boolean;
	/** Settles when the terminal is gone, so a shutdown stops waiting on output that can no longer be written. */
	readonly terminalLoss: Promise<void>;
	readonly settleTerminalLoss: () => void;
	/** Settles on a repeated SIGTERM, so a shutdown stops waiting for a session that runs in this process. */
	readonly forced: Promise<void>;
	readonly force: () => void;
}

const hostEndings = new WeakMap<InteractiveModeBase, HostEnding>();
const probeSessionEndedAt = new WeakMap<HostEnding, number>();
const probeLostAt = new WeakMap<HostEnding, number>();
function probeLog(line: string): void {
	try {
		appendFileSync(join(tmpdir(), "atomic-notice-latency.log"), `PROBE pid=${process.pid} ${line}\n`);
	} catch {}
}

function hostEnding(mode: InteractiveModeBase): HostEnding {
	let ending = hostEndings.get(mode);
	if (!ending) {
		const loss = Promise.withResolvers<void>();
		const forced = Promise.withResolvers<void>();
		ending = {
			sigterms: 0,
			terminalLost: false,
			consoleClosed: false,
			lostExitDeciding: false,
			terminalLoss: loss.promise,
			settleTerminalLoss: () => loss.resolve(),
			forced: forced.promise,
			force: () => forced.resolve(),
		};
		hostEndings.set(mode, ending);
	}
	return ending;
}

/** The exit status of a host whose terminal is gone. */
function terminalLostExitCode(ending: HostEnding): number {
	return ending.consoleClosed ? CONSOLE_CLOSED_EXIT_CODE : TERMINAL_LOST_EXIT_CODE;
}

/** What tells a host that its terminal is ending. Each notice moves the host's ending on; none depends on the order. */
type TerminalEndNotice =
	/** Windows said the console was closed: SIGHUP, the interactive engine's notice, or the end of the user's session. */
	| { readonly kind: "console-closed"; readonly closedMsAgo: number }
	/** The terminal is gone: its input ended, or a read or write found it dead. */
	| { readonly kind: "terminal-lost" };

/**
 * The host's terminal is ending, as `notice` says. Any notice shuts the session down as when its terminal is gone. Only
 * Windows' word that the console was closed proves that it was: a terminal found gone alone keeps the lost terminal's
 * bound and status, even on Windows, where the host can find its console gone well before its own notice, or the
 * interactive engine's, arrives. Once the close is proven, whatever came first, the shutdown is also bounded to end
 * before Windows would end this process, counted from when Windows said so, and Atomic exits with the status Windows
 * gives a console program it ends then.
 */
function terminalEnded(mode: InteractiveModeBase, notice: TerminalEndNotice): void {
	const ending = hostEnding(mode);
	if (notice.kind === "console-closed") {
		if (ending.consoleClosed) return;
		const endedAt = probeSessionEndedAt.get(ending);
		if (endedAt !== undefined) {
			probeLog(`notice-after-dispose latencyMs=${Math.round(performance.now() - endedAt)}`);
			ending.consoleClosed = true;
			mode.emergencyTerminalExit();
		}
		ending.consoleClosed = true;
		setTimeout(() => mode.emergencyTerminalExit(), Math.max(CONSOLE_CLOSED_SHUTDOWN_MS - notice.closedMsAgo, 0));
		// The terminal is gone with the console: that loss goes through the mode's own handler, as any other does.
		mode.handleTerminalLost();
		return;
	}
	if (ending.terminalLost) return;
	ending.terminalLost = true;
	probeLostAt.set(ending, performance.now());
	ending.settleTerminalLoss();
	spareEngineFromKill(mode);
	killSupervisedProcessTrees();
	setTimeout(() => lostTerminalBoundEnded(mode), TERMINAL_LOST_SHUTDOWN_MS);
	// A quit or a signal that is already shutting the session down goes on as it started.
	void mode.shutdown({ fromSignal: true });
}

/**
 * The lost terminal's bound has run out. On Windows, a host too busy to run its timers on time can get here with a
 * console-close notice already received but not yet read: Windows' own, read in this turn after the timers, or the
 * interactive engine's, whose line its reader parses in the turn after. Unless the close is already proven, those two
 * turns, and nothing more, are given to it before Atomic exits, so that it still decides the status.
 */
function lostTerminalBoundEnded(mode: InteractiveModeBase): void {
	const ending = hostEnding(mode);
	if (process.platform === "win32" && !ending.consoleClosed) {
		ending.lostExitDeciding = true;
		// A quit that stopped the screen also removed the handler of uncaught exceptions: without one, an exception in
		// these turns would end Atomic with 1. The exit removes this one with the other handlers.
		const decided = () => {};
		process.prependListener("uncaughtException", decided);
		mode.signalCleanupHandlers.push(() => process.off("uncaughtException", decided));
		setImmediate(() => {
			// Windows' own notice, read in the first turn, needs no second.
			if (ending.consoleClosed) return mode.emergencyTerminalExit();
			setImmediate(() => mode.emergencyTerminalExit());
		});
		return;
	}
	mode.emergencyTerminalExit();
}

/**
 * Exit as a host whose terminal is gone, with the status its notices decide; once that exit is deciding at the lost
 * terminal's bound, it is left to that exit. Returns only then.
 */
function exitAsTerminalLost(ending: HostEnding): void {
	if (ending.lostExitDeciding) return;
	exitWithStatus(terminalLostExitCode(ending));
}

/**
 * The Windows console was closed, or the Windows session ended, `closedMsAgo` milliseconds ago: this host was told so
 * (SIGHUP, or its hidden window at the end of the session), or its interactive engine, which hears of a closed console
 * first, said so.
 */
function consoleClosed(mode: InteractiveModeBase, closedMsAgo = 0): void {
	terminalEnded(mode, { kind: "console-closed", closedMsAgo });
}

/**
 * On Windows, shut the session down when its console is closed or the user's session ends (signing out, restarting or
 * shutting down), adding the listeners' removal to `cleanups`.
 */
function listenForConsoleClose(mode: InteractiveModeBase, cleanups: Array<() => void>): void {
	if (process.platform !== "win32") return;
	const handler = () => consoleClosed(mode);
	process.prependListener("SIGHUP", handler);
	cleanups.push(() => process.off("SIGHUP", handler));
	cleanups.push(onEngineConsoleClosed(mode.runtimeHost, handler));
	cleanups.push(onWindowsSessionEnd((endedMsAgo) => consoleClosed(mode, endedMsAgo)));
}

/**
 * Leave the interactive engine to the shutdown, and end every other child this host tracks at once. The shutdown asks
 * the engine to stop as one whose host was signalled, and the engine then ends its process group itself as it exits.
 */
function spareEngineFromKill(mode: InteractiveModeBase): void {
	killTrackedDetachedChildren(gracefullyStoppedEnginePids(mode.runtimeHost));
}

/**
 * Ctrl+C, in order: text in the editor is cleared; otherwise running work stops at once (as Escape does); otherwise
 * the first press says how to exit and a second press within {@link CTRL_C_EXIT_WINDOW_MS} exits. Clearing text or
 * stopping work never counts toward the exit, so a press meant for either cannot quit Atomic.
 */
InteractiveModeBase.prototype.handleCtrlC = function (this: InteractiveModeBase): void {
	if (isWindowsSubshellActive(this)) return;
	if (this.editor.getText() !== "") {
		this.clearEditor();
		this.lastSigintTime = 0;
		return;
	}
	// While a subagent is shown, an empty prompt's Ctrl+C pauses its work as Esc does; it never exits from there.
	// An engine that owes an abort is still terminated first, as the watchdog advertises.
	if (this.agentView?.viewed.kind === "agent" && !terminateInteractiveEngine(this.runtimeHost)) {
		leaveViewedAgent(this);
		this.lastSigintTime = 0;
		return;
	}
	if (this.interruptActiveOperation()) {
		this.lastSigintTime = 0;
		return;
	}
	const now = Date.now();
	if (now - this.lastSigintTime < CTRL_C_EXIT_WINDOW_MS) {
		void this.shutdown();
		return;
	}
	this.lastSigintTime = now;
	this.showStatus("Press Ctrl+C again to exit");
};

/**
 * A SIGINT signal, as opposed to the Ctrl+C key. In raw mode the keyboard sends Ctrl+C to the
 * editor as input, so a signal came from outside the TUI: on Windows, any process attached to
 * the same console that raises a console control event. It may interrupt running work, as the
 * key does, but never clears the editor or counts toward the double-press exit.
 */
InteractiveModeBase.prototype.handleSigintSignal = function (this: InteractiveModeBase): void {
	if (!process.stdin.isTTY || !process.stdin.isRaw) {
		this.handleCtrlC();
		return;
	}
	if (isWindowsSubshellActive(this)) return;
	if (this.interruptActiveOperation()) this.lastSigintTime = 0;
};

InteractiveModeBase.prototype.interruptActiveOperation = function (this: InteractiveModeBase): boolean {
	// Mirror the Escape interrupt paths so Ctrl+C aborts whichever operation is
	// currently running. Returns true when something was aborted.
	//
	// Escalate first when the interactive engine owes a cooperative abort or the
	// heartbeat watchdog calls it unresponsive: that is the explicit termination
	// the watchdog advertises with "Esc interrupt · Ctrl+C terminate". Every
	// cooperative route below would otherwise queue another request for a child
	// that cannot answer.
	if (terminateInteractiveEngine(this.runtimeHost)) {
		return true;
	}
	// While a subagent is shown, its running work is the one stopped, as Esc stops it; main's goes on.
	const viewed = interruptViewedAgent(this);
	if (viewed !== undefined) return viewed;
	if (this.session.isStreaming || this.session.agent.hasQueuedMessages()) {
		pauseAndAbortInteractiveSession(this);
		return true;
	}
	if (this.session.isBashRunning) {
		this.session.abortBash();
		return true;
	}
	if (this.session.isCompacting) {
		this.session.abortCompaction();
		return true;
	}
	if (this.session.isRetrying) {
		this.session.abortRetry();
		return true;
	}
	return false;
};

InteractiveModeBase.prototype.handleCtrlD = function (this: InteractiveModeBase): void {
	// Only called when editor is empty (enforced by CustomEditor)
	void this.shutdown();
};

InteractiveModeBase.prototype.shutdown = async function (
	this: InteractiveModeBase,
	options?: { fromSignal?: boolean },
): Promise<void> {
	if (this.isShuttingDown) return;
	this.isShuttingDown = true;
	stopRendererWatch(this);
	markEventLoopShutdown();
	// Keep signal handlers registered until terminal cleanup has completed.
	// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
	// dispatch and re-sends the signal if only its own listeners remain.

	const ending = hostEnding(this);
	if (options?.fromSignal) {
		await disposeRuntime(this, true);
		// A terminal that is gone is not restored.
		if (!ending.terminalLost) {
			this.themeController.disableAutoSync();
			// Drain any in-flight Kitty key release events briefly before stopping.
			// Keep this bounded so Ctrl+C exits do not feel stalled on Windows.
			await this.ui.terminal.drainInput(SHUTDOWN_INPUT_DRAIN_MAX_MS, SHUTDOWN_INPUT_DRAIN_IDLE_MS);
			if (!ending.terminalLost) stopTerminal(this);
		}
		if (ending.terminalLost && process.platform === "win32" && !ending.consoleClosed && !ending.lostExitDeciding) {
			probeSessionEndedAt.set(ending, performance.now());
			probeLog(
				`dispose-done-without-notice lostAgoMs=${Math.round(performance.now() - (probeLostAt.get(ending) ?? 0))}`,
			);
			return;
		}
		if (ending.terminalLost) exitAsTerminalLost(ending);
		else exitWithStatus(0);
		return;
	}

	// Drain any in-flight Kitty key release events briefly before stopping.
	// Keep this bounded so Ctrl+C exits do not feel stalled on Windows.
	this.themeController.disableAutoSync();
	if (!ending.terminalLost) {
		await this.ui.terminal.drainInput(SHUTDOWN_INPUT_DRAIN_MAX_MS, SHUTDOWN_INPUT_DRAIN_IDLE_MS);
	}

	// Output for a terminal that is gone is never written, so its end is not waited for.
	await Promise.race([chatHistoryBuilt(this.chatContainer), ending.terminalLoss]);
	// A terminal lost meanwhile is not restored either, and the handlers stay registered.
	if (!ending.terminalLost) {
		this.writeExitOutputInSlices = true;
		stopTerminal(this);
		// Stopping the screen removed every handler. A signal, a lost terminal or a closed Windows console still ends
		// Atomic as it would have before the screen stopped, rather than at once and before the session has shut down.
		registerEndingHandlers(this, this.signalCleanupHandlers);
	}
	await Promise.race([this.exitOutputWritten, ending.terminalLoss]);
	await disposeRuntime(this, false);
	if (ending.terminalLost) return exitAsTerminalLost(ending);
	const resumeCommand = await formatResumeCommand(this.sessionManager);
	// The terminal can be lost while the hint is being looked up; then it is not written.
	if (ending.terminalLost) return exitAsTerminalLost(ending);
	if (resumeCommand) {
		process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
	}
	process.exit(0);
};

/**
 * Dispose the session's runtime. An interactive engine's stop is bounded by its host, which ends the engine once its
 * grace period is over. A session that runs in this process gets the same: its `session_shutdown` handlers are waited
 * for until {@link ENGINE_SHUTDOWN_GRACE_MS} after the dispose starts, and the rest of its close is waited for as
 * usual. A repeated SIGTERM stops waiting at once and ends the processes this host started, as it ends an engine.
 */
async function disposeRuntime(mode: InteractiveModeBase, fromSignal: boolean): Promise<void> {
	const runtime = mode.runtimeHost;
	if (runsInteractiveEngine(runtime)) {
		await (fromSignal ? runtime.dispose({ fromSignal: true }) : runtime.dispose());
		return;
	}
	quitAsInteractiveApp(runtime, { handlerLimitMs: ENGINE_SHUTDOWN_GRACE_MS });
	const disposing = fromSignal ? runtime.dispose({ fromSignal: true }) : runtime.dispose();
	const forced = hostEnding(mode).forced.then(() => "forced" as const);
	if ((await Promise.race([disposing.then(() => "disposed" as const), forced])) === "disposed") return;
	void disposing.catch(() => {});
	killTrackedDetachedChildren();
	killSupervisedProcessTrees();
}

/** Stop the TUI. When the terminal turns out to be gone, the shutdown goes on without restoring it. */
function stopTerminal(mode: InteractiveModeBase): void {
	try {
		mode.stop();
	} catch (error) {
		if (!isDeadTerminalError(error)) throw error;
		mode.handleTerminalLost();
	}
}

/**
 * The terminal is gone, as when its window is closed. The session shuts down as it does on SIGHUP, which a closing
 * terminal sends too, so the interactive engine (or, without one, the session's own extensions) still runs its
 * shutdown. Other children end at once, nothing is drawn or restored, and Atomic exits with status 129 once the
 * session has shut down, or after {@link TERMINAL_LOST_SHUTDOWN_MS} at the latest.
 */
InteractiveModeBase.prototype.handleTerminalLost = function (this: InteractiveModeBase): void {
	terminalEnded(this, { kind: "terminal-lost" });
};

InteractiveModeBase.prototype.emergencyTerminalExit = function (this: InteractiveModeBase): never {
	this.isShuttingDown = true;
	this.unregisterSignalHandlers();
	killTrackedDetachedChildren();
	killSupervisedProcessTrees();
	// The terminal is gone. Do not run normal shutdown because TUI and
	// extension cleanup can write restore sequences and re-trigger EIO. The shutdown has not finished, so the
	// runtime's own exit still runs, whatever part of the status it keeps.
	process.exit(terminalLostExitCode(hostEnding(this)));
};

InteractiveModeBase.prototype.uncaughtCrash = function (this: InteractiveModeBase, error: Error): never {
	if (isDeadTerminalError(error) && (error as NodeJS.ErrnoException).syscall === "setRawMode") {
		this.emergencyTerminalExit();
	}
	if (this.isShuttingDown) {
		process.exit(1);
	}
	this.isShuttingDown = true;
	try {
		this.unregisterSignalHandlers();
	} catch {}
	try {
		killTrackedDetachedChildren();
	} catch {}
	killSupervisedProcessTrees();
	try {
		this.ui.stop();
	} catch {}
	console.error(`${APP_TITLE} exiting due to uncaughtException:`);
	console.error(error);
	const extensionHint = this.getCrashExtensionHint(error);
	if (extensionHint) console.error(`\n${extensionHint}`);
	process.exit(1);
};

InteractiveModeBase.prototype.getCrashExtensionHint = function (
	this: InteractiveModeBase,
	error: unknown,
): string | undefined {
	try {
		return formatCrashExtensionHint(
			findExtensionStackMatches(
				error instanceof Error ? error.stack : undefined,
				this.session.resourceLoader.getExtensions().extensions,
			),
		);
	} catch {
		return undefined;
	}
};

InteractiveModeBase.prototype.checkShutdownRequested = async function (this: InteractiveModeBase): Promise<void> {
	if (!this.shutdownRequested) return;
	await this.shutdown();
};

/**
 * Register the handlers that end Atomic on SIGTERM or SIGHUP, when its terminal is gone and when its Windows console is
 * closed, adding their removal to `cleanups`. A first signal starts the shutdown, or joins one already under way, which ends as it started.
 */
function registerEndingHandlers(mode: InteractiveModeBase, cleanups: Array<() => void>): void {
	const signals: NodeJS.Signals[] = ["SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}

	for (const signal of signals) {
		const handler = () => {
			const ending = hostEnding(mode);
			if (signal === "SIGTERM") ending.sigterms += 1;
			// The interactive engine is left to the shutdown, which gives it the bounded window a quit gives it to run
			// its extensions' shutdown. A closing terminal sends SIGHUP more than once, as the shell in it passes one on
			// and the kernel sends another when that shell exits, so only a repeated SIGTERM ends every child at once
			// and stops waiting for a session that runs in this process.
			if (ending.sigterms > 1) {
				killTrackedDetachedChildren();
				ending.force();
			} else spareEngineFromKill(mode);
			void mode.shutdown({ fromSignal: true });
		};
		process.prependListener(signal, handler);
		cleanups.push(() => process.off(signal, handler));
	}

	const terminalErrorHandler = (error: Error) => {
		if (!isDeadTerminalError(error)) {
			// Atomic's exit is already decided at the lost terminal's bound, and comes within its turns.
			if (hostEnding(mode).lostExitDeciding) return;
			throw error;
		}
		mode.handleTerminalLost();
	};
	for (const stream of [process.stdin, process.stdout, process.stderr]) {
		stream.on("error", terminalErrorHandler);
		cleanups.push(() => stream.off("error", terminalErrorHandler));
	}
	listenForConsoleClose(mode, cleanups);
}

InteractiveModeBase.prototype.registerSignalHandlers = function (this: InteractiveModeBase): void {
	this.unregisterSignalHandlers();

	registerEndingHandlers(this, this.signalCleanupHandlers);

	const sigintHandler = () => {
		this.handleSigintSignal();
	};
	process.prependListener("SIGINT", sigintHandler);
	this.signalCleanupHandlers.push(() => process.off("SIGINT", sigintHandler));
	// A terminal's input ends only when the terminal is gone: a key never ends it in raw mode. It ends before the
	// closing terminal's signals arrive, and a session with nothing else to do would otherwise end at once.
	const terminalInputEndHandler = () => {
		if (process.stdin.isTTY) this.handleTerminalLost();
	};
	process.stdin.on("end", terminalInputEndHandler);
	this.signalCleanupHandlers.push(() => process.stdin.off("end", terminalInputEndHandler));

	// Restore the terminal before the process dies on any uncaught throw.
	// Without this, an unhandled exception from extension code (or anywhere
	// in pi) leaves the terminal in raw mode with no cursor.
	// A feature whose code an update replaced while this session runs, and that no longer loads, fails alone: the
	// session goes on and says to restart instead of exiting.
	const uncaughtExceptionHandler = (error: Error) => {
		// Atomic's exit is already decided at the lost terminal's bound, and comes within its turns.
		if (hostEnding(this).lostExitDeciding) return;
		if (this.isShuttingDown || !(error instanceof UpdatedInstallError || isModuleLoadFailure(error))) {
			return this.uncaughtCrash(error);
		}
		void updatedInstallError(error, "this feature").then(
			(updated) => (updated && !this.isShuttingDown ? this.showError(updated.message) : this.uncaughtCrash(error)),
			() => this.uncaughtCrash(error),
		);
	};
	process.prependListener("uncaughtException", uncaughtExceptionHandler);
	this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
};

InteractiveModeBase.prototype.unregisterSignalHandlers = function (this: InteractiveModeBase): void {
	for (const cleanup of this.signalCleanupHandlers) {
		cleanup();
	}
	this.signalCleanupHandlers = [];
};

InteractiveModeBase.prototype.handleCtrlZ = function (this: InteractiveModeBase): void {
	if (process.platform === "win32") {
		void openWindowsSubshell(this).catch((error: Error) =>
			this.showStatus(`PowerShell subshell failed: ${error.message}`),
		);
		return;
	}

	// Keep the event loop alive while suspended. Without this, stopping the TUI
	// can leave Node with no ref'ed handles, causing the process to exit on fg
	// before the SIGCONT handler gets a chance to restore the terminal.
	const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

	// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
	// kill the backgrounded process. The handler is removed on resume.
	const ignoreSigint = () => {};
	process.on("SIGINT", ignoreSigint);

	// Set up handler to restore TUI when resumed
	process.once("SIGCONT", () => {
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		this.ui.start();
		this.ui.requestRender(true);
	});

	try {
		// Stop the TUI (restore terminal to normal mode)
		this.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	} catch (error) {
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		throw error;
	}
};

InteractiveModeBase.prototype.handleFollowUp = async function (this: InteractiveModeBase): Promise<void> {
	if (followUpViewedAgent(this)) return;
	// Main's prompt, also once the screen shows a subagent while this is on its way.
	const prompt = promptHandle(this, "main");
	const rawText = this.editor.getExpandedText?.() ?? this.editor.getText();
	const text = rawText.trim();
	if (!text) return;

	// Alt+Enter dispatches straight to the engine, exactly like the direct
	// branches of the Enter handler, so it needs the same send-failure restore:
	// otherwise a queued follow-up submitted while the engine is gone is lost.
	const dispatch = async (send: () => Promise<void>): Promise<void> => {
		try {
			await send();
		} catch (error) {
			if (!restoreFailedSubmissionDraft(this, error, rawText, { prompt })) throw error;
		}
	};

	// Queue input behind compaction-queued messages (extension commands execute immediately)
	if (
		this.compactionActive ||
		(!this.session.queuedMessagesPaused && (this.compactionFlushPending || this.compactionSendFailed))
	) {
		if (this.isExtensionCommand(text)) {
			prompt.addToHistory(text);
			prompt.setText("");
			// Messages the command sends must follow the ones already typed (#4251).
			if (this.compactionActive) handOffCompactionQueue(this);
			await dispatch(() => this.session.prompt(text));
		} else {
			this.queueCompactionMessage(text, "followUp");
		}
		return;
	}

	// A paused submission releases the session queue before its own turn, so move held
	// messages there first to keep them ahead of this one.
	if (this.session.queuedMessagesPaused && this.compactionSendFailed && !this.compactionFlushPending) {
		await this.flushCompactionQueue({ willRetry: false });
	}

	// Alt+Enter queues a follow-up message (waits until agent finishes)
	// This handles extension commands (execute immediately), prompt template expansion, and queueing
	if (this.session.isStreaming) {
		prompt.addToHistory(text);
		prompt.setText("");
		const submitted = await mainSteering(this).submit(text, "followUp", {
			route: "queue",
			// An extension command runs at once instead of queueing, so only other input is shown as queued (#4696).
			showAsQueued: !this.isExtensionCommand(text),
		});
		if (submitted.kind === "failed") throw submitted.error;
		if (submitted.kind === "lost") {
			this.showError(submitted.error.message);
			return;
		}
		if (submitted.kind === "refused") {
			// A refused follow-up goes back to the editor with the reason, as a refused steering message does (#4696).
			restoreRefusedSubmission(this, submitted.error, rawText, prompt);
			return;
		}
		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
	}
	// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit).
	// Hand over the raw expanded buffer, not the trimmed text: Alt+Enter is an
	// app action, so CustomEditor returns before its own pre-trim snapshot runs
	// and the submit handler's only draft is this argument. It trims the value
	// itself for delivery, so the agent still receives the normalized prompt.
	else if (this.editor.onSubmit) {
		this.editor.setText("");
		this.editor.onSubmit(rawText);
	}
};

InteractiveModeBase.prototype.handleDequeue = async function (this: InteractiveModeBase): Promise<void> {
	if (dequeueViewedAgent(this)) return;
	try {
		const restored = await this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		}
	} catch (error) {
		showQueueRestoreFailure(this, error);
	}
};
