import { waitForRawStdoutBackpressure } from "../../core/output-guard.ts";
import type { RpcCommandHandler } from "./rpc-command-handler.ts";
import type { RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import { isRpcExtensionUIResponse, isRpcInterruptCommand } from "./rpc-input-scheduler.ts";
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

function cancelsPendingCommand(interrupt: RpcCommand, pending: RpcCommand): boolean {
	if (interrupt.type === "abort") return pending.type === "prompt";
	if (interrupt.type === "abort_compaction") return pending.type === "compact";
	if (interrupt.type === "abort_bash") {
		return (
			(pending.type === "bash" || pending.type === "user_bash") &&
			(interrupt.requestId === undefined || interrupt.requestId === pending.id)
		);
	}
	return false;
}

export function createRpcInputLineHandler({
	output,
	pendingExtensionRequests,
	handleCommand,
	checkShutdownRequested,
	handleInteractiveEngineLine,
	announceRequestAccepted,
}: RpcInputLineHandlerOptions): (line: string) => Promise<void> {
	const pendingAdmissions = new Set<{ command: RpcCommand; cancelled: boolean }>();
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
			const identity = getCommandIdentity(command);
			for (const pending of pendingAdmissions) {
				if (cancelsPendingCommand(command, pending.command)) pending.cancelled = true;
			}
			if (announceRequestAccepted && identity.id !== undefined) {
				announceRequestAccepted(identity.id, identity.type);
				if (!isRpcInterruptCommand(identity.type)) {
					const pending = { command, cancelled: false };
					pendingAdmissions.add(pending);
					try {
						await waitForRawStdoutBackpressure();
					} finally {
						pendingAdmissions.delete(pending);
					}
					if (pending.cancelled) throw new Error("Request cancelled before execution");
				}
			}
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			const failed = getCommandIdentity(command);
			output(createRpcErrorResponse(failed.id, failed.type, formatRpcErrorMessage(commandError), commandError));
			await waitForRawStdoutBackpressure();
		}
	};
}
