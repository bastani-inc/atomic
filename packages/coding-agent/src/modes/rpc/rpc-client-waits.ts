import type { RpcEvent } from "./rpc-types.ts";

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
