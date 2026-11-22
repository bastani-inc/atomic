import { markEventLoopShutdown, markEventLoopStartupComplete } from "../../core/event-loop-monitor.ts";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";

/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import { bindBundledHintCommands, setKeybindings } from "@bastani/atomic-tui";
import type { AgentSession } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { quitAsInteractiveApp } from "../../core/interactive-quit.js";
import { KeybindingsManager } from "../../core/keybindings.ts";
import { prewarmModelApi } from "../../core/model-api-prewarm.ts";
import { flushRawStdout, rawStdoutWriteFailed, takeOverStdout, writeRawStdout } from "../../core/output-guard.ts";
import { QueuedDeliveryRelay } from "../../core/queued-message-delivery.ts";
import { onBlueprintBuildFinished, onBlueprintBuildWaiting } from "../../core/resume/blueprint/barrier.ts";
import { startedWithHangupIgnored } from "../../utils/inherited-hangup.js";
import { interactiveEngineStartupEnv, isInteractiveEngineChild } from "../../utils/interactive-engine-env.ts";
import { exitWithStatus } from "../../utils/process-exit-status.js";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { CONSOLE_CLOSED_EXIT_CODE, CONSOLE_CLOSED_SHUTDOWN_MS } from "../../utils/windows-console-close.js";
import { markHintRoutesAsEngine } from "../interactive/components/hint-routes.ts";
import { startInteractiveEngineLiveness } from "../interactive-engine/engine-child-liveness.ts";
import { EngineCustomUiService } from "../interactive-engine/engine-custom-ui.ts";
import { handleEngineHintRouteLine } from "../interactive-engine/engine-hint-route.ts";
import { endCommandsWhenHostIsGone } from "../interactive-engine/engine-host-loss.ts";
import { EngineInputFormService } from "../interactive-engine/engine-input-form.ts";
import { EngineProjectTrustService } from "../interactive-engine/engine-project-trust.js";
import {
	EngineQuitIntent,
	endProcessGroupAtExit,
	reportShutdownCompleteAtExit,
} from "../interactive-engine/engine-quit-intent.ts";
import { EngineRenderService } from "../interactive-engine/engine-render-service.ts";
import { EngineSessionPickerService } from "../interactive-engine/engine-session-picker.ts";
import { serializeInteractiveEngineMessage } from "../interactive-engine/protocol.ts";
import { attachJsonlLineReader } from "./jsonl.ts";
import { createRpcCommandHandler } from "./rpc-command-handler.ts";
import type { RpcExtensionUICapabilities, RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import { createRpcInputLineHandler } from "./rpc-input.ts";
import { createRpcInputScheduler } from "./rpc-input-scheduler.ts";
import { KeybindingsReloadCoordinator } from "./rpc-keybindings-reload.ts";
import { RpcOutputBuffer } from "./rpc-output-buffer.ts";
import { RpcResourceReadiness } from "./rpc-resource-readiness.ts";
import { rpcShutdownErrorEvent } from "./rpc-responses.ts";
import { RpcSessionBinding } from "./rpc-session-binding.ts";
import { RPC_SHUTDOWN_FAILED_EXIT_CODE } from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcShutdownErrorEvent,
} from "./rpc-types.ts";

export interface RpcModeOptions {
	deferInteractiveEngineResources?: boolean;
	onStartupReload?: (session: AgentSession) => Promise<void>;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime, options: RpcModeOptions = {}): Promise<never> {
	takeOverStdout({ nonBlockingPipe: true });

	const interactiveEngineChild = isInteractiveEngineChild();
	// The hints its chats draw are clicked in its host, which hands their routes back to it.
	if (interactiveEngineChild) markHintRoutesAsEngine();
	const deferInteractiveEngineResources = interactiveEngineChild && options.deferInteractiveEngineResources === true;
	const resourceReadiness = new RpcResourceReadiness();
	const keybindings = interactiveEngineChild ? KeybindingsManager.create(runtimeHost.services.agentDir) : undefined;
	if (keybindings) {
		setKeybindings(keybindings);
		bindBundledHintCommands(
			keybindings,
			(name) => runtimeHost.session.extensionRunner.getCommand(name)?.sourceInfo.configurationOrigin === "bundled",
		);
	}

	const outputBuffer = new RpcOutputBuffer();
	const output = outputBuffer.output;
	const pendingExtensionRequests: RpcPendingExtensionRequests = new Map();
	const extensionUICapabilities: RpcExtensionUICapabilities = { questionnaire: false };
	const engineLiveness = startInteractiveEngineLiveness(writeRawStdout);
	const customUi = keybindings ? new EngineCustomUiService(writeRawStdout, keybindings) : undefined;
	const renderService = interactiveEngineChild ? new EngineRenderService(writeRawStdout) : undefined;
	const sessionPicker = interactiveEngineChild ? new EngineSessionPickerService(writeRawStdout) : undefined;
	const inputForm = interactiveEngineChild ? new EngineInputFormService(writeRawStdout) : undefined;
	const quitIntent = interactiveEngineChild ? new EngineQuitIntent(writeRawStdout) : undefined;
	const hostPid = Number.parseInt(interactiveEngineStartupEnv().hostPid ?? "", 10);
	/** Whether this process's input ended: for an engine child, its host closed it or is gone. */
	let inputEnded = false;
	/** Whether this engine's exit ends its commands' processes when its host is gone, which reads `inputEnded`. */
	const watchesHostLoss =
		quitIntent !== undefined &&
		Number.isSafeInteger(hostPid) &&
		hostPid > 0 &&
		endCommandsWhenHostIsGone(
			hostPid,
			() => quitIntent.explicitQuitRequested,
			() => inputEnded || rawStdoutWriteFailed(),
		);
	const projectTrust = interactiveEngineChild
		? new EngineProjectTrustService(() => runtimeHost.session.extensionRunner)
		: undefined;
	const reloadCoordinator = keybindings
		? new KeybindingsReloadCoordinator<AgentSession>(
				keybindings,
				(state) =>
					writeRawStdout(serializeInteractiveEngineMessage({ type: "engine_keybindings_reloaded", state })),
				(session, effectiveBindings) =>
					[...session.extensionRunner.getShortcuts(effectiveBindings)].map(([key, shortcut]) => ({
						key,
						...(shortcut.description === undefined ? {} : { description: shortcut.description }),
						...(shortcut.editorKeys === undefined ? {} : { editorKeys: shortcut.editorKeys }),
					})),
			)
		: undefined;

	let shutdownRequested = false;
	let shuttingDown = false;
	// SIGTERM/SIGHUP received so far. Only a repeated signal forces exit during shutdown.
	let signalCount = 0;
	// Set once this interactive engine's Windows console was closed.
	let consoleClosed = false;
	let inputReady = false;
	let activeCommands = 0;
	// Count detached prompt work as well as input handling so responses precede shutdown.
	const beginCommand = () => {
		activeCommands++;
		return () => {
			activeCommands--;
			checkShutdownRequested();
		};
	};
	let detachInput = () => {};

	const requestShutdown = () => {
		shutdownRequested = true;
		setImmediate(checkShutdownRequested);
	};

	const sessionBinding = new RpcSessionBinding({
		runtimeHost,
		output,
		pendingExtensionRequests,
		extensionUICapabilities,
		requestShutdown,
		checkShutdownRequested,
		customUi,
		renderService,
		sessionPicker,
		inputForm,
		writeEngineLine: interactiveEngineChild ? writeRawStdout : undefined,
		// Only a host that asked for them reads the queued messages the main session is delivering.
		queuedDeliveries:
			interactiveEngineChild && interactiveEngineStartupEnv().queuedDeliveries
				? new QueuedDeliveryRelay()
				: undefined,
		reloadCoordinator,
		onStartupReload: deferInteractiveEngineResources ? options.onStartupReload : undefined,
	});
	const loadDeferredResources = () =>
		resourceReadiness.run(async () => {
			try {
				await sessionBinding.loadDeferredResources();
				markLifecycleTiming("engine-resources-ready");
				markEventLoopStartupComplete();
				engineLiveness.resourcesReady();
				setImmediate(() => {
					void prewarmModelApi(sessionBinding.currentSession.model, sessionBinding.currentSession.modelRuntime);
				});
			} catch (error) {
				const resourceError = error instanceof Error ? error : new Error(String(error));
				engineLiveness.resourcesFailed(resourceError);
				throw resourceError;
			}
		});

	// A resumed session's blueprint build may run behind its first turn (#4748): the client hears once that it ended,
	// with the warnings a resume that waits for it returns.
	const stopAnnouncingFinished = onBlueprintBuildFinished((finished) => output(finished));
	const stopAnnouncingWaits = onBlueprintBuildWaiting((waiting) => output(waiting));
	const stopAnnouncingBuilds = () => {
		stopAnnouncingFinished();
		stopAnnouncingWaits();
	};

	runtimeHost.setRebindSession(async () => {
		projectTrust?.dispose();
		await sessionBinding.rebindSession();
	});
	// The host mirrors this child's extension UI. Tell it to reset when a session retires, on the same
	// stdout stream as the UI requests, so the reset precedes those of the session that replaces it.
	if (interactiveEngineChild) {
		runtimeHost.setBeforeSessionInvalidate(() => {
			// The host forgets the queued messages the retiring session was delivering when it reads the reset.
			sessionBinding.retireQueuedDeliveries();
			writeRawStdout(serializeInteractiveEngineMessage({ type: "engine_extension_ui_reset" }));
		});
	}

	const handleCommand = createRpcCommandHandler({
		runtimeHost,
		getSession: () => sessionBinding.currentSession,
		rebindSession: () => sessionBinding.rebindSession(),
		output,
		keybindings,
		// Browsing host-owned task history is not an extension approval prompt.
		taskInspectorUi: customUi
			? { custom: customUi.custom.bind(customUi), getHostRenderSettings: () => customUi.getHostRenderSettings() }
			: undefined,
		reloadCoordinator,
		inputForm,
		pendingExtensionRequests,
		extensionUICapabilities,
		waitForResources: deferInteractiveEngineResources ? () => resourceReadiness.wait() : undefined,
		reloadResources: deferInteractiveEngineResources ? loadDeferredResources : undefined,
		shouldRetryResources: deferInteractiveEngineResources ? () => resourceReadiness.needsRetry() : undefined,
		detachCompaction: interactiveEngineChild,
		beginCommand,
	});

	/**
	 * Whether this shutdown ends the process but not the conversation. A signal and a
	 * closed stdin only do that when no explicit quit was announced: the interactive host
	 * announces one before it stops the engine, so anything else is the host being
	 * signalled or dying. A standalone RPC client has no such announcement; for it a
	 * signal is a host termination and a closed stdin or a shutdown request is a deliberate end.
	 */
	const endsProcessOnly = (cause: "signal" | "input-end" | "request"): boolean => {
		if (cause === "request") return false;
		if (quitIntent) return !quitIntent.explicitQuitRequested;
		return cause === "signal";
	};

	/** Dispose the runtime and exit. Runs once; later calls (stdin EOF after a signal) do nothing. */
	async function shutdown(
		exitCode = 0,
		signal?: NodeJS.Signals,
		cause: "signal" | "input-end" | "request" = "request",
	): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			(await import("node:fs")).appendFileSync(
				process.env.ATOMIC_QUIT_PROBE_LOG ?? "",
				`PROBE engine shutdown cause=${cause} signal=${signal ?? ""} explicit=${quitIntent?.explicitQuitRequested} inputEnded=${inputEnded}\n`,
			);
		} catch {}
		// An engine stopped by a signal or the end of its input, as when its host was signalled or, on Windows, its
		// console was closed, records its shutdown as an explicit quit does.
		if (interactiveEngineChild && cause !== "request") markEventLoopShutdown();
		detachInput();
		if (watchesHostLoss) {
			// Read the input to its end and drop it: a host killed while this engine shuts down after its signal closes
			// the input, and the exit then waits for the system to give this engine another parent before it decides
			// whether the host is gone.
			process.stdin.once("end", () => {
				inputEnded = true;
			});
			process.stdin.resume();
		} else process.stdin.pause();
		await handleCommand.disposeActiveBash();
		sessionBinding.disposeSubscriptions();
		stopAnnouncingBuilds();
		engineLiveness.stop();
		customUi?.dispose();
		renderService?.dispose();
		sessionPicker?.dispose();
		inputForm?.dispose();
		projectTrust?.dispose();
		outputBuffer.dispose();
		// An interactive engine quits as the interactive app does; its host bounds the handlers.
		if (interactiveEngineChild) quitAsInteractiveApp(runtimeHost);
		try {
			await runtimeHost.dispose({ fromSignal: endsProcessOnly(cause) });
		} catch (error) {
			// Disposal attempted every cleanup step; report what failed and exit non-zero rather than rejecting
			// unhandled inside a fire-and-forget shutdown (#5166).
			exitCode = exitCode === 0 ? RPC_SHUTDOWN_FAILED_EXIT_CODE : exitCode;
			output(rpcShutdownErrorEvent(error, exitCode));
		}
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		// On Windows the interactive host closes an engine child's stdin to quit, then waits for it to exit; tell it
		// once the shutdown has run, so it does not also wait for the runtime's own exit work. A host whose console
		// was closed waits for that exit too.
		if (interactiveEngineChild && (cause === "input-end" || consoleClosed) && process.platform === "win32")
			reportShutdownCompleteAtExit();
		// SIGHUP is the hangup of the host this engine serves, which asks with it when it was itself signalled: the
		// engine has no terminal of its own. It then ends its process group, as a hangup ends a terminal's job.
		if (interactiveEngineChild && signal === "SIGHUP" && endsProcessOnly(cause)) endProcessGroupAtExit();
		exitWithStatus(exitCode);
	}

	// Startup, command completion and agent settlement all retry an extension request.
	function checkShutdownRequested(): void {
		if (
			!shutdownRequested ||
			shuttingDown ||
			!inputReady ||
			activeCommands > 0 ||
			runtimeHost.session.isStreaming ||
			runtimeHost.session.isCompacting
		)
			return;
		void shutdown();
	}

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			// An interactive engine's SIGHUP is its host asking it to stop. A standalone run started with SIGHUP
			// ignored, as under `nohup`, goes on when its terminal closes.
			if (interactiveEngineChild || !startedWithHangupIgnored()) signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const exitCode = signal === "SIGHUP" ? 129 : 143;
			// Handlers stay registered until exit: without one, a signal during shutdown would kill
			// the process before dispose() finishes.
			process.on(signal, () => {
				signalCount++;
				killTrackedDetachedChildren();
				if (!shuttingDown) {
					void shutdown(exitCode, signal, "signal");
				} else if (signalCount > 1) {
					// Process managers often close stdin and send SIGTERM together, so one signal
					// during shutdown is not a request to skip cleanup; a repeated one is.
					process.exit(exitCode);
				}
			});
		}
		if (interactiveEngineChild && process.platform === "win32") {
			// Windows reports a closed console as SIGHUP, and nothing else. The engine shares its host's console, and
			// Windows tells the newest of the processes on it first: the engine before its host, which hears of it only
			// once the engine is gone. The engine tells its host at once, then shuts down as on SIGHUP elsewhere, within
			// a bound that ends before Windows would end it.
			process.on("SIGHUP", () => {
				if (consoleClosed) return;
				consoleClosed = true;
				writeRawStdout(serializeInteractiveEngineMessage({ type: "engine_console_closed" }));
				killTrackedDetachedChildren();
				setTimeout(() => process.exit(CONSOLE_CLOSED_EXIT_CODE), CONSOLE_CLOSED_SHUTDOWN_MS);
				void shutdown(CONSOLE_CLOSED_EXIT_CODE, "SIGHUP", "signal");
			});
		}
	};

	const handleInputLine = createRpcInputLineHandler({
		output,
		pendingExtensionRequests,
		handleCommand,
		checkShutdownRequested,
		beginCommand,
		// Only the interactive engine host consults this ownership boundary.
		announceRequestAccepted: interactiveEngineChild
			? (requestId, command) =>
					writeRawStdout(
						serializeInteractiveEngineMessage({ type: "engine_request_accepted", requestId, command }),
					)
			: undefined,
		handleInteractiveEngineLine:
			customUi || renderService || sessionPicker || inputForm || projectTrust || quitIntent
				? (line) =>
						quitIntent?.handleLine(line) === true ||
						customUi?.handleLine(line) === true ||
						renderService?.handleLine(line) === true ||
						sessionPicker?.handleLine(line) === true ||
						inputForm?.handleLine(line) === true ||
						projectTrust?.handleLine(line) === true ||
						(interactiveEngineChild && handleEngineHintRouteLine(line))
				: undefined,
	});

	const onInputEnd = () => {
		inputEnded = true;
		void shutdown(0, undefined, "input-end");
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const scheduleInputLine = createRpcInputScheduler(handleInputLine);
		const detachJsonl = attachJsonlLineReader(process.stdin, scheduleInputLine, {
			maxBytesPerTurn: 256 * 1024,
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();
	registerSignalHandlers();
	engineLiveness.ready();
	await sessionBinding.rebindSession();
	if (interactiveEngineChild) engineLiveness.bound();
	if (deferInteractiveEngineResources) {
		// RPC control and the mandatory minimal session are usable now. Prompt
		// handling remains generation-gated until a retryable transactional reload commits.
		void loadDeferredResources().catch(() => {});
	} else if (interactiveEngineChild) {
		markLifecycleTiming("engine-resources-ready");
		markEventLoopStartupComplete();
		engineLiveness.resourcesReady();
		setImmediate(() => {
			void prewarmModelApi(sessionBinding.currentSession.model, sessionBinding.currentSession.modelRuntime);
		});
	} else {
		setImmediate(() => {
			void prewarmModelApi(sessionBinding.currentSession.model, sessionBinding.currentSession.modelRuntime);
		});
	}
	inputReady = true;
	checkShutdownRequested();

	// Keep process alive forever
	return new Promise(() => {});
}
