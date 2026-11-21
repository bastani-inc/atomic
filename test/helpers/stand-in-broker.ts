/**
 * A stand-in Intercom broker for tests of broker cleanup: it listens on an agent dir's broker socket, answers
 * `broker_status` with its own pid as a broker does (or, with `pidless`, with a report that names none), records its pid
 * in `broker.pid` once it listens (with `listenAfterMs`, first records its pid and listens that much later, as a real
 * broker records its pid before it listens), and with `holdLog` keeps `broker.log` open.
 */
import { join } from "node:path";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { spawnProcess } from "./runtime.js";

const STAND_IN_BROKER = `const fs = require("node:fs");
const net = require("node:net");
const [socketPath, pidPath, logPath, pidless, listenAfter] = process.argv.slice(1);
if (logPath) fs.openSync(logPath, "a");
const frame = (message) => {
	const payload = Buffer.from(JSON.stringify(message));
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length);
	return Buffer.concat([header, payload]);
};
const server = net.createServer((socket) => {
	socket.on("error", () => {});
	let buffer = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
			const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString("utf8"));
			buffer = buffer.subarray(4 + buffer.readUInt32BE(0));
			if (message.type !== "broker_status") continue;
			const report = pidless === "pidless" ? {} : { pid: process.pid, sessions: 0, multiNode: { status: "off" } };
			socket.write(frame({ type: "broker_status", requestId: message.requestId, report }));
		}
	});
});
if (listenAfter) {
	fs.writeFileSync(pidPath, String(process.pid));
	setTimeout(() => server.listen(socketPath), Number(listenAfter));
} else server.listen(socketPath, () => fs.writeFileSync(pidPath, String(process.pid)));
setInterval(() => {}, 1000);`;

export interface StandInBroker {
	readonly pid: number;
	kill(signal: NodeJS.Signals): void;
	readonly exited: Promise<number>;
}

export function startStandInBroker(
	agentDir: string,
	{
		holdLog = false,
		pidless = false,
		listenAfterMs,
	}: { readonly holdLog?: boolean; readonly pidless?: boolean; readonly listenAfterMs?: number } = {},
): StandInBroker {
	const intercomDir = join(agentDir, "intercom");
	const child = spawnProcess({
		cmd: [
			process.execPath,
			"-e",
			STAND_IN_BROKER,
			getBrokerSocketPath(process.platform, agentDir),
			join(intercomDir, "broker.pid"),
			holdLog ? join(intercomDir, "broker.log") : "",
			pidless ? "pidless" : "",
			listenAfterMs === undefined ? "" : String(listenAfterMs),
		],
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error("the stand-in broker did not start");
	return { pid, kill: (signal) => child.kill(signal), exited: child.exited };
}
