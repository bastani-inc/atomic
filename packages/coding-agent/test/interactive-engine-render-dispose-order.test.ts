import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { EngineRenderService } from "../src/modes/interactive-engine/engine-render-service.js";
import type { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../src/modes/interactive-engine/protocol.js";
import { RemoteToolExecutionComponent } from "../src/modes/interactive-engine/remote-renderer.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

beforeAll(() => {
	initTheme("dark");
});

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Larger than a pipe's buffer, so the engine's stdin backs up while it does not read. */
const LARGE_ARGS_BYTES = 1024 * 1024;

function toolRow(runtime: IsolatedInteractiveRuntime, toolCallId: string, args: object): RemoteToolExecutionComponent {
	return new RemoteToolExecutionComponent("bash", toolCallId, args, {}, runtime, () => {});
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("a row disposed while its render waits behind a backed-up engine connection is not rendered after its disposal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-render-dispose-order-"));
	tempDirs.push(dir);
	const go = join(dir, "go");
	const log = join(dir, "commands.jsonl");
	const engine = join(dir, "engine.mjs");
	// An engine that does not read its stdin until told to, then records the commands it reads, in order.
	writeFileSync(
		engine,
		`import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ type: "engine_ready", protocolVersion: 4, pid: process.pid }) + "\\n");
const wait = setInterval(() => {
	if (!existsSync(${JSON.stringify(go)})) return;
	clearInterval(wait);
	createInterface({ input: process.stdin }).on("line", (line) => {
		const command = JSON.parse(line);
		appendFileSync(${JSON.stringify(log)}, JSON.stringify({ type: command.type, componentId: command.componentId }) + "\\n");
	});
}, 10);`,
	);
	const client = new RpcClient({ cliPath: engine, runtimeExecutable: process.execPath });
	await client.start();
	try {
		const runtime = {
			onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) =>
				client.onInteractiveEngineMessage(listener),
			sendEngineCommand: (command: InteractiveEngineCommand) => client.sendInteractiveEngineCommand(command),
		} as unknown as IsolatedInteractiveRuntime;
		const chat = new StartupChatContainer();
		chat.releaseStartupOutput();
		// The first row's render is larger than the pipe, so the second row's render waits in the host's queue.
		chat.addChild(toolRow(runtime, "call_large", { command: "x".repeat(LARGE_ARGS_BYTES) }));
		chat.addChild(toolRow(runtime, "call_waiting", { command: "ls" }));
		chat.render(80);

		chat.clear();
		writeFileSync(go, "");

		const commands = () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { type: string; componentId: string })
				: [];
		await waitFor(
			() => commands().filter((command) => command.type === "engine_render_dispose").length === 2,
			"both disposals to reach the engine",
		);
		// Anything still queued behind the disposals has been written by the time a later frame arrives.
		client.sendInteractiveEngineCommand({ type: "engine_render_dispose", componentId: "end-marker" });
		await waitFor(
			() => commands().some((command) => command.componentId === "end-marker"),
			"the end marker to reach the engine",
		);

		const received = commands();
		for (const [index, command] of received.entries()) {
			if (command.type !== "engine_render_dispose") continue;
			const lateRender = received
				.slice(index + 1)
				.find((later) => later.type === "engine_tool_render" && later.componentId === command.componentId);
			assert.equal(lateRender, undefined, `${command.componentId} was rendered after its disposal`);
		}
	} finally {
		await client.stop();
	}
});

test("a render that reaches the engine after its row's disposal does not bring the renderer back", async () => {
	const sent: InteractiveEngineMessage[] = [];
	const service = new EngineRenderService((line) => {
		const message = parseInteractiveEngineMessage(line.trim());
		if (message) sent.push(message);
	});
	service.bindSession({
		extensionRunner: { resolveToolRenderers: () => undefined },
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => "/" },
	} as unknown as AgentSession);
	const render = (componentId: string, requestId: number): InteractiveEngineCommand => ({
		type: "engine_tool_render",
		componentId,
		requestId,
		width: 80,
		toolName: "bash",
		toolCallId: `call_${componentId}`,
		args: { command: "ls" },
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		imageWidthCells: 60,
		outputPad: 1,
	});
	const line = (command: InteractiveEngineCommand) => serializeInteractiveEngineFrame(command).trim();
	try {
		service.handleLine(line(render("live", 1)));
		// The disposal overtook this row's render on the way to the engine.
		service.handleLine(line({ type: "engine_render_dispose", componentId: "disposed" }));
		service.handleLine(line(render("disposed", 1)));
		// Disposed while its render waits for its turn.
		service.handleLine(line(render("disposed_while_waiting", 1)));
		service.handleLine(line({ type: "engine_render_dispose", componentId: "disposed_while_waiting" }));

		await waitFor(
			() => sent.some((message) => message.type === "engine_custom_frame" && message.componentId === "live"),
			"the live row's frame",
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const framed = new Set(
			sent.flatMap((message) => (message.type === "engine_custom_frame" ? [message.componentId] : [])),
		);
		assert.deepEqual([...framed], ["live"]);
	} finally {
		service.dispose();
	}
});
