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

import { setKeybindings } from "@earendil-works/pi-tui";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import { flushRawStdout, takeOverStdout, writeRawStdout } from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { EngineCustomUiService } from "../interactive-engine/engine-custom-ui.ts";
import { EngineInputFormService } from "../interactive-engine/engine-input-form.ts";
import { EngineRenderService } from "../interactive-engine/engine-render-service.ts";
import { EngineSessionPickerService } from "../interactive-engine/engine-session-picker.ts";
import { startInteractiveEngineLiveness } from "../interactive-engine/engine-child-liveness.ts";
import { INTERACTIVE_ENGINE_MAX_FRAME_BYTES, serializeInteractiveEngineMessage } from "../interactive-engine/protocol.ts";
import { attachJsonlLineReader } from "./jsonl.ts";
import { createRpcCommandHandler } from "./rpc-command-handler.ts";
import { createRpcInputLineHandler } from "./rpc-input.ts";
import { createRpcInputScheduler } from "./rpc-input-scheduler.ts";
import type { RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import { RpcOutputBuffer } from "./rpc-output-buffer.ts";
import { RpcSessionBinding } from "./rpc-session-binding.ts";
import { KeybindingsReloadCoordinator } from "./rpc-keybindings-reload.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcContextWindowInfo,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();

	const interactiveEngineChild = process.env.ATOMIC_INTERACTIVE_ENGINE_CHILD === "1";
	const keybindings = interactiveEngineChild ? KeybindingsManager.create(runtimeHost.services.agentDir) : undefined;
	if (keybindings) setKeybindings(keybindings);

	const outputBuffer = new RpcOutputBuffer();
	const output = outputBuffer.output;
	const pendingExtensionRequests: RpcPendingExtensionRequests = new Map();
	const signalCleanupHandlers: Array<() => void> = [];
	const engineLiveness = startInteractiveEngineLiveness(writeRawStdout);
	const customUi = keybindings
		? new EngineCustomUiService(writeRawStdout, keybindings)
		: undefined;
	const renderService = interactiveEngineChild
		? new EngineRenderService(writeRawStdout)
		: undefined;
	const sessionPicker = interactiveEngineChild
		? new EngineSessionPickerService(writeRawStdout)
		: undefined;
	const inputForm = interactiveEngineChild
		? new EngineInputFormService(writeRawStdout)
		: undefined;
	const reloadCoordinator = keybindings
		? new KeybindingsReloadCoordinator<AgentSession>(
				keybindings,
				(state) => writeRawStdout(serializeInteractiveEngineMessage({ type: "engine_keybindings_reloaded", state })),
				(session, effectiveBindings) => [...session.extensionRunner.getShortcuts(effectiveBindings)]
					.map(([key, shortcut]) => ({
						key,
						...(shortcut.description === undefined ? {} : { description: shortcut.description }),
					})),
			)
		: undefined;

	let shutdownRequested = false;
	let shuttingDown = false;
	let detachInput = () => {};

	const requestShutdown = () => {
		shutdownRequested = true;
	};

	const sessionBinding = new RpcSessionBinding({
		runtimeHost,
		output,
		pendingExtensionRequests,
		requestShutdown,
		customUi,
		renderService,
		sessionPicker,
		inputForm,
		reloadCoordinator,
	});

	runtimeHost.setRebindSession(async () => {
		await sessionBinding.rebindSession();
	});

	const handleCommand = createRpcCommandHandler({
		runtimeHost,
		getSession: () => sessionBinding.currentSession,
		rebindSession: () => sessionBinding.rebindSession(),
		output,
		keybindings,
		reloadCoordinator,
		inputForm,
	});

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		sessionBinding.disposeSubscriptions();
		engineLiveness.stop();
		customUi?.dispose();
		renderService?.dispose();
		sessionPicker?.dispose();
		inputForm?.dispose();
		outputBuffer.dispose();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	const checkShutdownRequested = async (): Promise<void> => {
		if (!shutdownRequested) return;
		await shutdown();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};


	const handleInputLine = createRpcInputLineHandler({
		output,
		pendingExtensionRequests,
		handleCommand,
		checkShutdownRequested,
		handleInteractiveEngineLine: customUi || renderService || sessionPicker || inputForm
			? (line) => customUi?.handleLine(line) === true || renderService?.handleLine(line) === true || sessionPicker?.handleLine(line) === true || inputForm?.handleLine(line) === true
			: undefined,
	});

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const scheduleInputLine = createRpcInputScheduler(handleInputLine);
		const detachJsonl = attachJsonlLineReader(process.stdin, scheduleInputLine, {
			maxBytesPerTurn: 256 * 1024,
			maxFrameBytes: INTERACTIVE_ENGINE_MAX_FRAME_BYTES,
			onOversizedLine: () => output({ type: "response", command: "parse", success: false, error: "RPC command exceeded the 1 MiB frame limit" }),
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();
	registerSignalHandlers();
	engineLiveness.ready();
	await sessionBinding.rebindSession();
	engineLiveness.bound();

	// Keep process alive forever
	return new Promise(() => {});
}
