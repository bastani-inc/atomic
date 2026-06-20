import { waitForRawStdoutBackpressure } from "../../core/output-guard.ts";
import type { RpcCommandHandler } from "./rpc-command-handler.ts";
import type { RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import { createRpcErrorResponse, formatRpcErrorMessage, type RpcOutput } from "./rpc-responses.ts";
import type { RpcCommand, RpcExtensionUIResponse } from "./rpc-types.ts";

interface RpcInputLineHandlerOptions {
	output: RpcOutput;
	pendingExtensionRequests: RpcPendingExtensionRequests;
	handleCommand: RpcCommandHandler;
	checkShutdownRequested: () => Promise<void>;
}

interface CommandIdentity {
	id: string | undefined;
	type: string;
}

function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "extension_ui_response" &&
		"id" in value &&
		typeof value.id === "string"
	);
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
}: RpcInputLineHandlerOptions): (line: string) => Promise<void> {
	return async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(createRpcErrorResponse(undefined, "parse", `Failed to parse command: ${formatRpcErrorMessage(parseError)}`));
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
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			const identity = getCommandIdentity(command);
			output(createRpcErrorResponse(identity.id, identity.type, formatRpcErrorMessage(commandError)));
			await waitForRawStdoutBackpressure();
		}
	};
}
