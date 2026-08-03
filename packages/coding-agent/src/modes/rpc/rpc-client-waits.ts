import type { BashResult } from "../../core/bash-executor.ts";
import type { BashOutputChannel } from "../../core/tools/bash.ts";
import type { RpcEvent, RpcResponse } from "./rpc-types.ts";

export interface RpcEventSource {
	onEvent(listener: (event: RpcEvent) => void): () => void;
	getStderr(): string;
}

export function waitForRpcIdle(source: RpcEventSource, timeout: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${source.getStderr()}`));
		}, timeout);
		const unsubscribe = source.onEvent((event) => {
			if (event.type !== "agent_end") return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
	});
}

export function collectRpcEvents(source: RpcEventSource, timeout: number): Promise<RpcEvent[]> {
	return new Promise((resolve, reject) => {
		const events: RpcEvent[] = [];
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${source.getStderr()}`));
		}, timeout);
		const unsubscribe = source.onEvent((event) => {
			events.push(event);
			if (event.type !== "agent_end") return;
			clearTimeout(timer);
			unsubscribe();
			resolve(events);
		});
	});
}

/**
 * Run a user bash command, forwarding only the output of that request.
 *
 * The id is learned from the send itself, so the subscription is registered
 * before the command starts and still filters by correlation.
 */
export async function runUserBashWithUpdates(
	source: RpcEventSource,
	command: string,
	onUpdate: (delta: string, channel: BashOutputChannel) => void,
	options: { excludeFromContext?: boolean; onRequestId?: (id: string) => void } | undefined,
	send: (
		body: { type: "user_bash"; command: string; excludeFromContext?: boolean },
		onRequestId: (id: string) => void,
	) => Promise<RpcResponse>,
): Promise<BashResult> {
	let requestId: string | undefined;
	const unsubscribe = source.onEvent((event) => {
		if (event.type === "bash_execution_update" && event.id === requestId) onUpdate(event.delta, event.channel);
	});
	try {
		const response = await send(
			{ type: "user_bash", command, excludeFromContext: options?.excludeFromContext },
			(id) => {
				requestId = id;
				options?.onRequestId?.(id);
			},
		);
		if (!response.success) throw new Error(response.error);
		return (response as Extract<RpcResponse, { success: true; data: unknown }>).data as BashResult;
	} finally {
		unsubscribe();
	}
}
