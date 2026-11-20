import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { isRpcRequestAcceptedFailure } from "../src/modes/rpc/rpc-transport-error.js";

const tempDirs: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const POLL_MS = 10;

/**
 * An engine child that holds the host's `get_state` and `get_available_models` requests (and says so in `arrived`)
 * and, when it is stopped (SIGTERM, or the end of its stdin), writes what an engine's shutdown can still write: an
 * extension notification, an engine frame and an agent event, then that it took the models request, the state
 * request's response and a failed shutdown's report, and exits. Asked for its commands, it writes a tool update
 * and a heartbeat in one write, so the host reads both in one turn and `onHeartbeat` can answer with a stop.
 */
function startEngine(onHeartbeat?: () => void): { client: RpcClient; arrived: string } {
	const dir = mkdtempSync(join(tmpdir(), "atomic-stopped-generation-"));
	tempDirs.push(dir);
	const script = join(dir, "engine.mjs");
	const arrived = join(dir, "arrived");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const line = (frame) => JSON.stringify(frame) + "\\n";
const send = (frame) => process.stdout.write(line(frame));
send({ type: "engine_ready", protocolVersion: 4, pid: process.pid });
let held;
let taken;
createInterface({ input: process.stdin }).on("line", (input) => {
	const command = JSON.parse(input);
	if (command.type === "get_state") held = command.id;
	if (command.type === "get_available_models") taken = command.id;
	if (held && taken) writeFileSync(${JSON.stringify(arrived)}, "");
	if (command.type === "get_commands") {
		process.stdout.write(
			line({ type: "tool_execution_update", toolCallId: "call", toolName: "bash", args: {}, partialResult: { content: [] } }) +
				line({ type: "engine_heartbeat", at: 0 }),
		);
	}
});
let stopping = false;
const shutdown = () => {
	if (stopping) return;
	stopping = true;
	send({ type: "extension_ui_request", id: "late-notify", method: "notify", message: "shutting down", notifyType: "info" });
	send({ type: "engine_resources_ready" });
	send({ type: "agent_end", messages: [] });
	if (taken) send({ type: "engine_request_accepted", requestId: taken, command: "get_available_models" });
	if (held) send({ type: "response", id: held, command: "get_state", success: true, data: { answered: "late" } });
	send({ type: "shutdown_error", error: "cleanup failed", exitCode: 1 });
	setTimeout(() => process.exit(0), 100);
};
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
`,
	);
	const client = new RpcClient({
		cliPath: script,
		runtimeExecutable: process.execPath,
		interactiveEngine: { onDiagnostic: () => {}, ...(onHeartbeat ? { onHeartbeat } : {}) },
	});
	return { client, arrived };
}

async function stopAndObserve(windows: boolean) {
	const { client, arrived } = startEngine();
	const extensionUi: string[] = [];
	const events: string[] = [];
	const ended: string[] = [];
	client.onExtensionUIRequest((request) => extensionUi.push(request.id));
	client.onEvent((event) => events.push(event.type));
	client.onGenerationEnded((event) => ended.push(event.kind));
	await client.start();
	const held = client.getState().then(JSON.stringify, (error: Error) => error.message);
	const taken = client.getAvailableModels().then(
		() => "resolved",
		(error: Error) => (isRpcRequestAcceptedFailure(error) ? "accepted" : "not accepted"),
	);
	while (!existsSync(arrived)) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	if (windows) Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	try {
		await client.stop({ graceful: true });
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
	return {
		extensionUi,
		events,
		ended,
		held: await held,
		takenFailure: await taken,
	};
}

/** Start an engine and stop it from `onHeartbeat`, right after the host read a tool update it still holds. */
async function stopAfterBufferedUpdate(onEvent: (type: string) => void): Promise<{ stopped: Promise<void> }> {
	let stopped: Promise<void> | undefined;
	const { client } = startEngine(() => {
		stopped ??= client.stop();
	});
	client.onEvent((event) => onEvent(event.type));
	client.onGenerationEnded((event) => onEvent(event.kind));
	await client.start();
	void client.getCommands().catch(() => {});
	while (!stopped) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	return { stopped };
}

afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient stopped engine generation", () => {
	const expected = {
		extensionUi: [],
		events: ["shutdown_error"],
		ended: ["explicit-stop"],
		held: JSON.stringify({ answered: "late" }),
		takenFailure: "accepted",
	};

	test.skipIf(process.platform === "win32")(
		"a SIGTERMed engine's shutdown output no longer reaches the host's listeners (#6075)",
		async () => {
			assert.deepEqual(await stopAndObserve(false), expected);
		},
	);

	test("a Windows engine's shutdown output no longer reaches the host's listeners (#6075)", async () => {
		assert.deepEqual(await stopAndObserve(true), expected);
	});

	test("an update read before a stop reaches the host before the stop is published (#6075)", async () => {
		const order: string[] = [];
		const { stopped } = await stopAfterBufferedUpdate((type) => order.push(type));
		await stopped;

		// On Windows this stop ends the engine at once, so it reports no failed shutdown.
		assert.deepEqual(
			order.filter((type) => type !== "shutdown_error"),
			["tool_execution_update", "explicit-stop"],
		);
	});

	test("a listener that throws on that update neither fails the stop nor sees the update again (#6075)", async () => {
		const order: string[] = [];
		const { stopped } = await stopAfterBufferedUpdate((type) => {
			order.push(type);
			if (type === "tool_execution_update") throw new Error("listener failed");
		});

		await stopped;
		// On Windows this stop ends the engine at once, so it reports no failed shutdown.
		assert.deepEqual(
			order.filter((type) => type !== "shutdown_error"),
			["tool_execution_update", "explicit-stop"],
		);
	});
});
