import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { setCallbackActivityReporter } from "../src/core/callback-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { EngineRenderService } from "../src/modes/interactive-engine/engine-render-service.js";
import type { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineCommand,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../src/modes/interactive-engine/protocol.js";
import { RemoteToolExecutionComponent } from "../src/modes/interactive-engine/remote-renderer.js";

beforeAll(() => initTheme("dark", false));

const closers: Array<() => void> = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

function isolatedEngine() {
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const sent: InteractiveEngineCommand[] = [];
	setCallbackActivityReporter({ started() {}, finished() {} });
	const service = new EngineRenderService((line) => {
		const message = parseInteractiveEngineMessage(line.trim());
		if (message) for (const listener of [...listeners]) listener(message);
	});
	service.bindSession({
		extensionRunner: { resolveToolRenderers: () => undefined },
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => "/workspace" },
	} as unknown as AgentSession);
	const runtime = {
		onEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendEngineCommand(command: InteractiveEngineCommand) {
			sent.push(command);
			service.handleLine(serializeInteractiveEngineFrame(command).trim());
		},
	} as unknown as IsolatedInteractiveRuntime;
	closers.push(() => {
		service.dispose();
		setCallbackActivityReporter(undefined);
	});
	return { runtime, sent };
}

async function frame(row: RemoteToolExecutionComponent, width: number, pattern: RegExp): Promise<string[]> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const lines = row.render(width).map((line) => stripTerminalSequences(line).trimEnd());
		if (lines.some((line) => pattern.test(line))) return lines;
		if (Date.now() > deadline) throw new Error(`no frame matching ${pattern}: ${lines.join("\n")}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function readRow(runtime: IsolatedInteractiveRuntime, id: string): RemoteToolExecutionComponent {
	const row = new RemoteToolExecutionComponent("read", id, { path: `${id}.ts` }, { outputPad: 1 }, runtime, () => {});
	row.setArgsComplete();
	row.markExecutionStarted();
	row.updateResult({ content: [{ type: "text", text: "line" }], isError: false });
	return row;
}

test("the isolated engine draws the group row and hidden members cost no render request (#5350)", async () => {
	const { runtime, sent } = isolatedEngine();
	const [head, second, third] = ["a", "b", "c"].map((id) => readRow(runtime, id));
	if (!head || !second || !third) throw new Error("rows");
	head.setGroupRole({ kind: "head", clauses: [{ family: "read", count: 3 }] });
	second.setGroupRole({ kind: "hidden" });
	third.setGroupRole({ kind: "hidden" });
	for (const width of [80, 160]) {
		const lines = await frame(head, width, /Read 3 files/);
		assert.equal(lines.filter((line) => /Read\(/.test(line)).length, 0, lines.join("\n"));
		assert.deepEqual(second.render(width), []);
		assert.deepEqual(third.render(width), []);
	}
	const rendered = new Set(
		sent.flatMap((command) => (command.type === "engine_tool_render" ? [command.toolCallId] : [])),
	);
	assert.deepEqual([...rendered], ["a"]);
	second.setExpanded(true);
	await frame(second, 80, /Read\(/);
});

test("an isolated row keeps its observed start time across rebuilt engine records (#5350)", async () => {
	const { runtime, sent } = isolatedEngine();
	const row = new RemoteToolExecutionComponent(
		"read",
		"slow",
		{ path: "slow.ts" },
		{ outputPad: 1 },
		runtime,
		() => {},
	);
	row.setArgsComplete();
	row.markExecutionStarted(Date.now() - 4_000);
	row.markExecutionStarted(Date.now());
	const lines = await frame(row, 80, /Read\(/);
	assert.match(lines.find((line) => /Read\(/.test(line)) ?? "", /· 4s/);
	const command = sent.find((candidate) => candidate.type === "engine_tool_render");
	assert.equal(command?.type === "engine_tool_render" ? typeof command.executionStartedAt : "missing", "number");
});

test("the render protocol keeps a valid group role and drops a malformed one (#5350)", () => {
	const base = {
		type: "engine_tool_render",
		componentId: "row",
		requestId: 1,
		width: 80,
		toolName: "read",
		toolCallId: "a",
		args: {},
		executionStarted: true,
		executionStartedAt: 1_000,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		imageWidthCells: 60,
	};
	const valid = parseInteractiveEngineCommand(
		JSON.stringify({
			...base,
			groupRole: {
				kind: "head",
				clauses: [
					{ family: "read", count: 2 },
					{ family: "bash", count: 1 },
				],
			},
		}),
	);
	assert.deepEqual(valid?.type === "engine_tool_render" ? [valid.groupRole, valid.executionStartedAt] : undefined, [
		{
			kind: "head",
			clauses: [
				{ family: "read", count: 2 },
				{ family: "bash", count: 1 },
			],
		},
		1_000,
	]);
	for (const groupRole of [
		{ kind: "head", clauses: [] },
		{ kind: "head", clauses: [{ family: "edit", count: 1 }] },
		{ kind: "head", clauses: [{ family: "read", count: 0 }] },
		{ kind: "group" },
	]) {
		const parsed = parseInteractiveEngineCommand(JSON.stringify({ ...base, groupRole }));
		assert.equal(parsed?.type === "engine_tool_render" ? parsed.groupRole : "unparsed", undefined);
	}
});

test("a rebuilt isolated row never repaints a frame drawn for a different group role (#5350)", async () => {
	const { runtime } = isolatedEngine();
	const first = readRow(runtime, "rebuilt");
	await frame(first, 80, /Read\(/);
	first.dispose();
	const send = runtime.sendEngineCommand;
	runtime.sendEngineCommand = () => {};
	const rebuilt = readRow(runtime, "rebuilt");
	const standalone = readRow(runtime, "rebuilt");
	try {
		rebuilt.setGroupRole({ kind: "head", clauses: [{ family: "read", count: 2 }] });
		assert.deepEqual(rebuilt.render(80), []);
		assert.ok(standalone.render(80).some((line) => /Read\(/.test(stripTerminalSequences(line))));
	} finally {
		runtime.sendEngineCommand = send;
		rebuilt.dispose();
		standalone.dispose();
	}
});

test("an isolated folded row is drawn on its own, collapsed, while a click has left its group's first row expanded", async () => {
	const { runtime, sent } = isolatedEngine();
	const [head, folded] = ["a", "b"].map((id) => readRow(runtime, id));
	if (!head || !folded) throw new Error("rows");
	head.setGroupRole({ kind: "head", clauses: [{ family: "read", count: 2 }] });
	folded.setGroupRole({ kind: "hidden" });
	folded.setGroupHead({ isExpanded: () => head.isExpanded() });
	assert.deepEqual(folded.render(80), []);

	head.setExpanded(true);
	await frame(folded, 80, /Read\(b\.ts\)/);
	const request = sent.filter((command) => command.type === "engine_tool_render" && command.toolCallId === "b").at(-1);
	assert.equal(request?.type === "engine_tool_render" ? request.groupRole : "missing", undefined);
	assert.equal(request?.type === "engine_tool_render" ? request.expanded : "missing", false);
	assert.equal(folded.drawsApart(), true);

	head.setExpanded(false);
	assert.deepEqual(folded.render(80), [], "folded into the summary again");
	assert.equal(folded.drawsApart(), false);
});
