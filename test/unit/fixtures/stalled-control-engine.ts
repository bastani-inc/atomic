import { createInterface } from "node:readline";
import { INTERACTIVE_ENGINE_PROTOCOL_VERSION } from "../../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import type { RpcCommand } from "../../../packages/coding-agent/src/modes/rpc/rpc-types.js";

function write(value: object): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

write({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: process.pid });
write({ type: "engine_bound" });
setInterval(() => write({ type: "engine_heartbeat", at: Date.now() }), 25);

let stalled = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	if (stalled) return;
	const command = JSON.parse(line) as RpcCommand;
	let data: object;
	switch (command.type) {
		case "get_state":
			data = {
				thinkingLevel: "off",
				isStreaming: true,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: "stalled-control-engine",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 1,
			};
			break;
		case "get_available_models":
			data = { models: [], scopedModels: [], customAuthProviders: [] };
			break;
		case "get_commands":
			data = { commands: [] };
			break;
		case "prompt":
			stalled = true;
			write({ type: "queue_update", steering: ["queued before stall"], followUp: [] });
			write({ type: "response", command: command.type, id: command.id, success: true, data: { disposition: "started" } });
			lines.pause();
			return;
		default:
			data = {};
	}
	write({ type: "response", command: command.type, id: command.id, success: true, data });
});
