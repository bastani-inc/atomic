/**
 * How an isolated engine tells its host which queued messages its main session is delivering: on the event lines it
 * already writes, only for a host that asked when it started the engine, and taken off each line before anything else
 * in the host sees the event.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { type QueuedDeliveryChange, QueuedDeliveryRelay } from "../src/core/queued-message-delivery.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { RpcSessionBinding } from "../src/modes/rpc/rpc-session-binding.js";
import type { RpcEvent } from "../src/modes/rpc/rpc-types.js";
import { createGate, holdTool, waitFor } from "./helpers/busy-submission-rig.js";
import { busyTurnResponses } from "./helpers/steering-chats.js";
import { createHarness, type Harness } from "./suite/harness.js";

type Line = Record<string, unknown> & { type?: string };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The lines an engine's binding writes for its session, with or without a relay for the host. */
async function engineLines(relay: QueuedDeliveryRelay | undefined) {
	const toolHold = createGate();
	const harness: Harness = await createHarness({ tools: [holdTool(toolHold)] });
	cleanups.push(() => harness.cleanup());
	harness.setResponses(busyTurnResponses());
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("unused factory");
		},
	);
	const lines: Line[] = [];
	const binding = new RpcSessionBinding({
		runtimeHost: runtime,
		output: (record) => lines.push(JSON.parse(JSON.stringify(record)) as Line),
		pendingExtensionRequests: new Map(),
		requestShutdown: () => {},
		writeEngineLine: () => {},
		...(relay ? { queuedDeliveries: relay } : {}),
	});
	cleanups.push(() => binding.disposeSubscriptions());
	await binding.rebindSession();
	return {
		binding,
		lines,
		session: harness.session,
		/** A turn holding in its tool round takes `text`, queued meanwhile, at its next turn boundary. */
		async deliver(text: string) {
			const turn = harness.session.prompt("first");
			await toolHold.entered.promise;
			await harness.session.prompt(text, { streamingBehavior: "steer" });
			toolHold.release.resolve();
			await turn;
			await waitFor("the run to settle", () => lines.some((line) => line.type === "agent_settled"));
		},
	};
}

function changes(lines: readonly Line[]): { type: string | undefined; change: unknown }[] {
	return lines
		.filter((line) => "atomicQueuedDeliveries" in line)
		.map((line) => ({ type: line.type, change: line.atomicQueuedDeliveries }));
}

describe("the lines an engine writes about the queued messages its main session delivers", () => {
	test("tell a host that asked about a taken message with the queue_update that drops it, and its end with its message_start (#6080)", async () => {
		const engine = await engineLines(new QueuedDeliveryRelay());
		await engine.deliver("later one");
		assert.deepEqual(changes(engine.lines), [
			{ type: "queue_update", change: { taken: [{ lane: "steer", text: "later one" }] } },
			{ type: "message_start", change: { ended: 1 } },
		]);
		const dropping = engine.lines.find((line) => "atomicQueuedDeliveries" in line);
		const { atomicQueuedDeliveries: _change, ...publicPart } = dropping ?? {};
		// Apart from the change, the line is the event as the session sent it.
		assert.deepEqual(publicPart, { type: "queue_update", steering: [], followUp: [] });
	});

	test("carry nothing for a host that did not ask, as before (#6080)", async () => {
		const engine = await engineLines(undefined);
		await engine.deliver("later one");
		assert.deepEqual(changes(engine.lines), []);
		assert.ok(engine.lines.some((line) => line.type === "queue_update"));
	});

	test("carry nothing more once the binding's session is being replaced (#6080)", async () => {
		const engine = await engineLines(new QueuedDeliveryRelay());
		engine.binding.retireQueuedDeliveries();
		await engine.deliver("later one");
		assert.deepEqual(changes(engine.lines), []);
	});
});

describe("a host's client reading an engine's lines", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * An engine child that reports whether its host asked for the messages it delivers (in its startup record), then
	 * writes a tool update the host buffers, and a queue_update that names one.
	 */
	function engineScript(): string {
		const dir = mkdtempSync(join(tmpdir(), "atomic-queued-deliveries-"));
		dirs.push(dir);
		const path = join(dir, "engine.mjs");
		writeFileSync(
			path,
			`import { readFileSync } from "node:fs";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const at = process.argv.indexOf("--internal-engine-bootstrap");
const asked = at !== -1 && JSON.parse(readFileSync(process.argv[at + 1], "utf8")).queuedDeliveries === true;
send({ type: "engine_ready", protocolVersion: 4, pid: process.pid });
send({ type: "session_info_changed", name: asked ? "asked" : "not asked" });
send({ type: "tool_execution_update", toolCallId: "call", toolName: "hold", args: {}, partialResult: { content: [] } });
send({ type: "queue_update", steering: [], followUp: [], atomicQueuedDeliveries: { taken: [{ lane: "steer", text: "later one" }] } });
process.stdin.resume();
`,
		);
		return path;
	}

	test("asks the engine for them and takes each change off its line, after older events and before its own (#6080)", async () => {
		const client = new RpcClient({ cliPath: engineScript(), interactiveEngine: { onDiagnostic: () => {} } });
		cleanups.push(() => client.stop());
		const events: RpcEvent[] = [];
		const received: QueuedDeliveryChange[] = [];
		const order: string[] = [];
		client.onQueuedDeliveryChange((change) => {
			received.push(change);
			order.push("change");
		});
		client.onEvent((event) => {
			events.push(event);
			order.push(event.type);
		});
		await client.start();
		await waitFor("the queue_update", () => events.some((event) => event.type === "queue_update"));

		assert.deepEqual(
			events.filter((event) => event.type !== "tool_execution_update"),
			[
				{ type: "session_info_changed", name: "asked" },
				{ type: "queue_update", steering: [], followUp: [] },
			],
		);
		assert.deepEqual(received, [{ taken: [{ lane: "steer", text: "later one" }] }]);
		// The tool update written before it reaches its listeners first, with the queue it was sent with.
		assert.deepEqual(order, ["session_info_changed", "tool_execution_update", "change", "queue_update"]);
	});
});
