import { setImmediate } from "node:timers/promises";
import {
	restoreStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../../packages/coding-agent/src/core/output-guard.js";
import type { RpcCommandHandler } from "../../../packages/coding-agent/src/modes/rpc/rpc-command-handler.js";
import { createRpcInputLineHandler } from "../../../packages/coding-agent/src/modes/rpc/rpc-input.js";
import { createRpcSuccessResponse } from "../../../packages/coding-agent/src/modes/rpc/rpc-responses.js";
import type { RpcCommand } from "../../../packages/coding-agent/src/modes/rpc/rpc-types.js";

const originalWrite = process.stdout.write;
const writes: string[] = [];
const callbacks: Array<() => void> = [];
let draining = false;
process.stdout.write = ((chunk: string, callback?: () => void): boolean => {
	writes.push(chunk);
	if (callback) {
		if (draining) callback();
		else callbacks.push(callback);
	}
	return draining;
}) as typeof process.stdout.write;
takeOverStdout();

const handled: string[] = [];
const handleCommand = Object.assign(
	async (command: Parameters<RpcCommandHandler>[0]) => {
		handled.push(command.type);
		return createRpcSuccessResponse(command.id, command.type, {});
	},
	{ disposeActiveBash: async () => {} },
) as RpcCommandHandler;
const handleLine = createRpcInputLineHandler({
	output: (record) => writeRawStdout(`${JSON.stringify(record)}\n`),
	pendingExtensionRequests: new Map(),
	handleCommand,
	checkShutdownRequested: async () => {},
	announceRequestAccepted: (requestId, command) =>
		writeRawStdout(`${JSON.stringify({ type: "engine_request_accepted", requestId, command })}\n`),
});

const frames = Array.from({ length: 256 }, (_, index) => `${JSON.stringify({ index, output: "x".repeat(4096) })}\n`);
for (const frame of frames) writeRawStdout(frame);
const commands: RpcCommand[] = process.argv[2]
	? JSON.parse(process.argv[2])
	: [
			{ type: "prompt", message: "cancel this prompt", id: "prompt" },
			{ type: "bash", command: "echo cancel this command", id: "bash" },
			{ type: "user_bash", command: "echo cancel this user command", id: "user_bash" },
			{ type: "compact", id: "compact" },
		];
const controls: RpcCommand[] = process.argv[3]
	? JSON.parse(process.argv[3])
	: [
			{ type: "pause_queued_messages" },
			{ type: "resume_queued_messages" },
			{ type: "clear_queue" },
			{ type: "abort" },
			{ type: "abort_bash" },
			{ type: "abort_compaction" },
			{ type: "abort_retry" },
			{ type: "cancel_login_provider" },
		];
const work = commands.map((command) => handleLine(JSON.stringify(command)));
const requests = controls.map((command) => handleLine(JSON.stringify({ ...command, id: command.type })));
await setImmediate();
const handledBeforeDrain = [...handled];
draining = true;
for (const callback of callbacks.splice(0)) callback();
await Promise.all([...work, ...requests]);
await waitForRawStdoutBackpressure();
restoreStdout();
process.stdout.write = originalWrite;
process.stdout.write(
	`${JSON.stringify({ handledBeforeDrain, handled, preservedFrames: writes.slice(0, frames.length).every((frame, index) => frame === frames[index]), output: writes.slice(frames.length) })}\n`,
);
