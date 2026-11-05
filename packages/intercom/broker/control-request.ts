import { randomUUID } from "node:crypto";
import net from "node:net";
import { createMessageReader, type JsonWireValue, writeMessage } from "./framing.js";

/** How long a control request waits for its answer; a status report may wait up to 2 s for the shared database. */
export const BROKER_CONTROL_TIMEOUT_MS = 5_000;

export type ControlReply =
	| { readonly connected: false }
	| { readonly connected: true; readonly reply?: JsonWireValue; readonly timedOut?: true };

/** Send one control frame and wait for the reply of `replyType`; a broker that closes without one yields no reply. */
export function controlRequest(
	socketPath: string,
	type: "broker_status" | "shutdown",
	replyType: "broker_status" | "shutdown_ack",
	timeoutMs: number,
): Promise<ControlReply> {
	return new Promise((resolve) => {
		const requestId = randomUUID();
		const socket = net.connect(socketPath);
		let connected = false;
		let settled = false;
		const finish = (result: ControlReply): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish(connected ? { connected, timedOut: true } : { connected: false }), timeoutMs);
		socket.on("connect", () => {
			connected = true;
			writeMessage(socket, { type, requestId });
		});
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if (
						typeof message === "object" &&
						message !== null &&
						!Array.isArray(message) &&
						message.type === replyType &&
						message.requestId === requestId
					)
						finish({ connected: true, reply: message });
				},
				() => finish({ connected }),
			),
		);
		socket.on("error", () => finish(connected ? { connected } : { connected: false }));
		socket.on("close", () => finish(connected ? { connected } : { connected: false }));
	});
}
