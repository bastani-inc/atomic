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

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { flushRawStdout, takeOverStdout, writeRawStdout } from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { EngineCustomUiService } from "../interactive-engine/engine-custom-ui.ts";
import { startInteractiveEngineLiveness } from "../interactive-engine/engine-child-liveness.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { createRpcCommandHandler } from "./rpc-command-handler.ts";
import { createRpcInputLineHandler } from "./rpc-input.ts";
import type { RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import type { RpcOutput } from "./rpc-responses.ts";
import { RpcSessionBinding } from "./rpc-session-binding.ts";

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

	const output: RpcOutput = (obj) => {
		writeRawStdout(serializeJsonLine(obj));
	};
	const pendingExtensionRequests: RpcPendingExtensionRequests = new Map();
	const signalCleanupHandlers: Array<() => void> = [];
	const engineLiveness = startInteractiveEngineLiveness(writeRawStdout);
	const customUi = process.env.ATOMIC_INTERACTIVE_ENGINE_CHILD === "1"
		? new EngineCustomUiService(writeRawStdout)
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
	});

	runtimeHost.setRebindSession(async () => {
		await sessionBinding.rebindSession();
	});

	const handleCommand = createRpcCommandHandler({
		runtimeHost,
		getSession: () => sessionBinding.currentSession,
		rebindSession: () => sessionBinding.rebindSession(),
		output,
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
		handleInteractiveEngineLine: customUi ? (line) => customUi.handleLine(line) : undefined,
	});

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
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
