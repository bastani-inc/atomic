import { waitForRawStdoutBackpressure } from "../../core/output-guard.ts";
import type { RpcCommandHandler } from "./rpc-command-handler.ts";
import type { RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import { isRpcExtensionUIResponse } from "./rpc-input-scheduler.ts";
import { createRpcErrorResponse, formatRpcErrorMessage, type RpcOutput } from "./rpc-responses.ts";
import type { RpcCommand } from "./rpc-types.ts";

interface RpcInputLineHandlerOptions {
	output: RpcOutput;
	pendingExtensionRequests: RpcPendingExtensionRequests;
	handleCommand: RpcCommandHandler;
	checkShutdownRequested: () => Promise<void>;
	handleInteractiveEngineLine?: (line: string) => boolean;
	/**
	 * Announce that this child owns a correlated request, before any handler
	 * work runs. Interactive-engine children only; plain RPC has no host that
	 * needs the ownership boundary.
	 */
	announceRequestAccepted?: (requestId: string, command: string) => void;
}

interface CommandIdentity {
	id: string | undefined;
	type: string;
}

function getCommandIdentity(command: unknown): CommandIdentity {
	if (typeof command !== "object" || command === null) {
		return { id: undefined, type: "unknown" };
	}
	const id = "id" in command && typeof command.id === "string" ? command.id : undefined;
	const type = "type" in command && typeof command.type === "string" ? command.type : "unknown";
	return { id, type };
}

export function createRpcInputLineHandler({
	output,
	pendingExtensionRequests,
	handleCommand,
	checkShutdownRequested,
	handleInteractiveEngineLine,
	announceRequestAccepted,
}: RpcInputLineHandlerOptions): (line: string) => Promise<void> {
	return async (line: string): Promise<void> => {
		if (handleInteractiveEngineLine?.(line)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				createRpcErrorResponse(undefined, "parse", `Failed to parse command: ${formatRpcErrorMessage(parseError)}`),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		if (isRpcExtensionUIResponse(parsed)) {
			const pending = pendingExtensionRequests.get(parsed.id);
			if (pending) {
				pendingExtensionRequests.delete(parsed.id);
				pending.resolve(parsed);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			// Ownership boundary: flush the admission frame BEFORE the handler can
			// touch the shell, an extension, or the queue. A command that runs to
			// completion without output would otherwise be indistinguishable from
			// one the child never received, and the host would offer the user's
			// text back for a second run.
			const identity = getCommandIdentity(command);
			if (announceRequestAccepted && identity.id !== undefined) {
				announceRequestAccepted(identity.id, identity.type);
				await waitForRawStdoutBackpressure();
			}
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			const failed = getCommandIdentity(command);
			output(createRpcErrorResponse(failed.id, failed.type, formatRpcErrorMessage(commandError)));
			await waitForRawStdoutBackpressure();
		}
	};
}
