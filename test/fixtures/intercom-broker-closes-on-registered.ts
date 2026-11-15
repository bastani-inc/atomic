import net from "node:net";
import { createMessageReader } from "../../packages/intercom/broker/framing.js";

/** A session registering under this name has its socket closed right after the broker writes `registered` to it. */
const CLOSES_ON_REGISTERED_NAME = "closes-on-registered";

// #5149: the broker sees the socket close during the registration it is completing, after `registered` and before
// the replies held for the session are written.
const emit = net.Server.prototype.emit;
net.Server.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
	const socket = args[0];
	if (event === "connection" && socket instanceof net.Socket) {
		socket.on(
			"data",
			createMessageReader(
				(frame) => {
					if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.type !== "register") return;
					const session = frame.session;
					if (!session || typeof session !== "object" || Array.isArray(session)) return;
					if (session.name !== CLOSES_ON_REGISTERED_NAME) return;
					const write = socket.write.bind(socket);
					socket.write = ((chunk: Buffer, ...rest: []) => {
						const written = write(chunk, ...rest);
						if (chunk.toString("utf8").includes('"type":"registered"')) socket.destroy();
						return written;
					}) as typeof socket.write;
				},
				(error) => {
					throw error;
				},
			),
		);
	}
	return Reflect.apply(emit, this, [event, ...args]);
};
await import(new URL("../../packages/intercom/broker/broker.ts", import.meta.url).href);
