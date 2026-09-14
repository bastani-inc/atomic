import net from "node:net";
import { createMessageReader } from "../../packages/intercom/broker/framing.js";

// #3039 observation only: retain actual broker-side receipt time, not send-result time.
// The independent reader neither consumes nor replaces the broker's routing callback.
const emit = net.Server.prototype.emit;
net.Server.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
	if (event === "connection" && args[0] instanceof net.Socket) {
		args[0].on("data", createMessageReader((frame) => {
			if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.type !== "supervisor_send") return;
			const message = frame.message;
			if (!message || typeof message !== "object" || Array.isArray(message)) return;
			console.log(JSON.stringify({ boundary: "broker-receipt", at: Date.now(), id: message.id, sentAt: message.timestamp, source: message.source, to: frame.to }));
		}, (error) => { throw error; }));
	}
	return Reflect.apply(emit, this, [event, ...args]);
};
// Resolve the independent broker entrypoint at runtime, as the production launcher does.
await import(new URL("../../packages/intercom/broker/broker.ts", import.meta.url).href);
