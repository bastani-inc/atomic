/**
 * Broker preload for #5096 tests: makes one forwarded live-stage write fail, as if the target's socket stopped
 * accepting frames between resolving the target and writing to it.
 *
 * A socket that has sent `FORWARD_FAULT_TARGET` (its registration name) is the target. A frame containing
 * `ARM_FORWARD_WRITE_FAULT` arms the one fault this broker injects: the next time the broker checks whether that target's socket is
 * writable while forwarding a live-stage message, the socket reports itself ended.
 */
import net from "node:net";

const FORWARD_FAULT_TARGET = "forward-fault-target";
const ARM_FORWARD_WRITE_FAULT = "ARM-FORWARD-WRITE-FAULT";

const targets = new WeakSet();
let armed = false;
let spent = false;

const push = net.Socket.prototype.push;
net.Socket.prototype.push = function (chunk, encoding) {
	if (chunk !== null && chunk !== undefined) {
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		if (text.includes(FORWARD_FAULT_TARGET)) targets.add(this);
		if (!spent && text.includes(ARM_FORWARD_WRITE_FAULT)) armed = true;
	}
	return push.call(this, chunk, encoding);
};

let owner = net.Socket.prototype;
let descriptor;
while (owner !== null && descriptor === undefined) {
	descriptor = Object.getOwnPropertyDescriptor(owner, "writableEnded");
	owner = Object.getPrototypeOf(owner);
}
if (descriptor?.get === undefined) throw new Error("writableEnded getter not found");
const writableEnded = descriptor.get;
Object.defineProperty(net.Socket.prototype, "writableEnded", {
	configurable: true,
	get() {
		if (armed && targets.has(this) && new Error().stack?.includes("forwardValidatedLiveStageMessage")) {
			armed = false;
			spent = true;
			console.error("forward write fault injected");
			return true;
		}
		return writableEnded.call(this);
	},
});
