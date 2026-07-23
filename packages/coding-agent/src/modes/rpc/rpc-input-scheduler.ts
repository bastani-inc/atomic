import { parseInteractiveEngineCommand } from "../interactive-engine/protocol.ts";
import type { RpcExtensionUIResponse } from "./rpc-types.ts";

const INTERRUPT_COMMANDS: ReadonlySet<string> = new Set([
	"abort",
	"cancel_login_provider",
	"abort_compaction",
	"abort_retry",
	"abort_bash",
]);

export function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	return typeof value === "object" && value !== null &&
		"type" in value && value.type === "extension_ui_response" &&
		"id" in value && typeof value.id === "string";
}

/**
 * Control frames must remain reachable while an ordinary RPC command is
 * pending. Interrupts cancel that command, while host responses can unblock UI
 * work awaited by it. Everything else stays on the ordered command lane.
 */
export function isConcurrentRpcControlLine(line: string): boolean {
	if (parseInteractiveEngineCommand(line)) return true;
	let value: object | null;
	try {
		const parsed = JSON.parse(line) as object | boolean | null | number | string;
		value = typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return false;
	}
	if (isRpcExtensionUIResponse(value)) return true;
	return value !== null && "type" in value && typeof value.type === "string" && INTERRUPT_COMMANDS.has(value.type);
}

/**
 * Runs ordinary RPC input one frame at a time while giving validated control
 * frames an independent lane. The first ordinary frame starts synchronously,
 * so a following interrupt cannot overtake initialization of the operation it
 * is intended to cancel.
 */
export function createRpcInputScheduler(handleLine: (line: string) => Promise<void>): (line: string) => void {
	const ordinaryQueue: string[] = [];
	let ordinaryActive = false;

	const invoke = (line: string): Promise<void> => {
		try {
			return handleLine(line);
		} catch (error) {
			return Promise.reject(error);
		}
	};

	const startNextOrdinary = (): void => {
		const line = ordinaryQueue.shift();
		if (line === undefined) {
			ordinaryActive = false;
			return;
		}
		ordinaryActive = true;
		void invoke(line).finally(startNextOrdinary).catch(() => {});
	};

	return (line: string): void => {
		if (isConcurrentRpcControlLine(line)) {
			void invoke(line).catch(() => {});
			return;
		}
		ordinaryQueue.push(line);
		if (!ordinaryActive) startNextOrdinary();
	};
}
