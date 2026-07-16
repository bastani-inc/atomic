import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";
import type { ActivityWatchdogDiagnostic } from "../../packages/coding-agent/src/modes/interactive-engine/activity-watchdog.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { parseInteractiveEngineMessage, serializeInteractiveEngineFrame } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { attachJsonlLineReader } from "../../packages/coding-agent/src/modes/rpc/jsonl.ts";

function maximumGap(timestamps: readonly number[]): number {
	let maximum = 0;
	for (let index = 1; index < timestamps.length; index += 1) {
		maximum = Math.max(maximum, timestamps[index]! - timestamps[index - 1]!);
	}
	return maximum;
}


test.serial("the real agent path isolates a blocking extension tool and reports its child PID", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-isolation-"));
	const pidFile = join(tempDir, "tool.pid");
	const heartbeatTimes: number[] = [performance.now()];
	let inputTicks = 0;
	let renderTicks = 0;
	const heartbeat = setInterval(() => heartbeatTimes.push(performance.now()), 10);
	const input = setInterval(() => { inputTicks += 1; }, 20);
	const render = setInterval(() => { renderTicks += 1; }, 16);
	let resolveDiagnostic!: (diagnostic: ActivityWatchdogDiagnostic) => void;
	const diagnosticPromise = new Promise<ActivityWatchdogDiagnostic>((resolve) => {
		resolveDiagnostic = resolve;
	});
	const client = new RpcClient({
		cliPath: join(import.meta.dir, "../../packages/coding-agent/src/cli.ts"),
		cwd: join(import.meta.dir, "../.."),
		runtimeExecutable: process.execPath,
		provider: "isolation-fixture",
		model: "blocking-model",
		env: { ATOMIC_BLOCKING_TOOL_PID_FILE: pidFile },
		args: [
			"--no-session", "--no-extensions", "--extension",
			join(import.meta.dir, "fixtures", "blocking-tool-extension.ts"),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--offline",
		],
		interactiveEngine: { onDiagnostic: resolveDiagnostic },
	});
	try {
		await client.start();
		await client.waitForInteractiveEngineBound();
		await client.prompt("run the blocking tool");
		const diagnostic = await diagnosticPromise;
		assert.equal(diagnostic.level, "blocking");
		assert.equal(diagnostic.activity?.kind, "tool.execute");
		assert.equal(diagnostic.activity?.name, "busy_loop");
		assert.match(diagnostic.message, /Engine callback tool\.execute busy_loop has not yielded/);
		assert.notEqual(Number(readFileSync(pidFile, "utf8")), process.pid, "tool callback ran in the TUI host process");
		const inputAtDiagnostic = inputTicks;
		const rendersAtDiagnostic = renderTicks;
		await Bun.sleep(150);
		assert.ok(inputTicks > inputAtDiagnostic, "input proxy stopped during the real blocking tool");
		assert.ok(renderTicks > rendersAtDiagnostic, "render proxy stopped during the real blocking tool");
	} finally {
		await client.stop();
		clearInterval(heartbeat);
		clearInterval(input);
		clearInterval(render);
		heartbeatTimes.push(performance.now());
		rmSync(tempDir, { recursive: true, force: true });
	}
	const observedMaximumGap = maximumGap(heartbeatTimes);
	assert.ok(observedMaximumGap <= 100, `host heartbeat gap ${observedMaximumGap.toFixed(1)} ms exceeded 100 ms`);
});

test("remote custom components render and receive input through the engine protocol", async () => {
	const output: string[] = [];
	const service = new EngineCustomUiService((line) => output.push(line));
	const result = service.custom<string>((_tui, _theme, _keybindings, done) => ({
		render: (width) => [`width:${width},rows:${_tui.terminal.rows}`],
		handleInput: (data) => { if (data === "\r") done("accepted"); },
		invalidate: () => {},
	}));
	await Bun.sleep(0);
	const open = output.map(parseInteractiveEngineMessage).find((message) => message?.type === "engine_custom_open");
	assert.ok(open?.type === "engine_custom_open");
	service.handleLine(serializeInteractiveEngineFrame({
		type: "engine_custom_render", componentId: open.componentId, requestId: 1, width: 72, rows: 40,
	}));
	await Bun.sleep(0);
	const frame = output.map(parseInteractiveEngineMessage).find((message) => message?.type === "engine_custom_frame");
	assert.ok(frame?.type === "engine_custom_frame");
	assert.deepEqual(frame.lines, ["width:72,rows:40"]);
	service.handleLine(serializeInteractiveEngineFrame({
		type: "engine_custom_input", componentId: open.componentId, data: "\r",
	}));
	assert.equal(await result, "accepted");
	service.dispose();
});

test.serial("startup custom UI can unblock engine binding after transport readiness", async () => {
	const client = new RpcClient({
		cliPath: join(import.meta.dir, "../../packages/coding-agent/src/cli.ts"),
		cwd: join(import.meta.dir, "../.."),
		runtimeExecutable: process.execPath,
		provider: "isolation-fixture",
		model: "blocking-model",
		env: { ATOMIC_STARTUP_CUSTOM_UI: "1" },
		args: [
			"--no-session", "--no-extensions", "--extension",
			join(import.meta.dir, "fixtures", "blocking-tool-extension.ts"),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--offline",
		],
		interactiveEngine: { onDiagnostic: () => {} },
	});
	try {
		await client.start();
		const open = await new Promise<{ componentId: string }>((resolve) => {
			client.onInteractiveEngineMessage((message) => {
				if (message.type === "engine_custom_open") resolve(message);
			});
		});
		client.sendInteractiveEngineCommand({ type: "engine_custom_input", componentId: open.componentId, data: "\r" });
		await Promise.race([
			client.waitForInteractiveEngineBound(),
			Bun.sleep(2_000).then(() => { throw new Error("engine binding did not resume after startup custom UI"); }),
		]);
	} finally {
		await client.stop();
	}
});

test.serial("blocking extension initialization cannot delay creation of the interactive host", async () => {
	const ticks: number[] = [performance.now()];
	const heartbeat = setInterval(() => ticks.push(performance.now()), 10);
	let resolveDiagnostic!: (diagnostic: ActivityWatchdogDiagnostic) => void;
	const diagnosticPromise = new Promise<ActivityWatchdogDiagnostic>((resolve) => { resolveDiagnostic = resolve; });
	const client = new RpcClient({
		cliPath: join(import.meta.dir, "../../packages/coding-agent/src/cli.ts"),
		cwd: join(import.meta.dir, "../.."),
		runtimeExecutable: process.execPath,
		provider: "isolation-fixture",
		model: "blocking-model",
		env: { ATOMIC_BLOCKING_EXTENSION_INIT: "1" },
		args: [
			"--no-session", "--no-extensions", "--extension",
			join(import.meta.dir, "fixtures", "blocking-tool-extension.ts"),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--offline",
		],
		interactiveEngine: { onDiagnostic: resolveDiagnostic },
	});
	try {
		const startedAt = performance.now();
		await client.start();
		assert.ok(performance.now() - startedAt < 800, "host creation waited for blocking extension initialization");
		const diagnostic = await diagnosticPromise;
		assert.equal(diagnostic.level, "blocking");
		await client.waitForInteractiveEngineBound();
	} finally {
		await client.stop();
		clearInterval(heartbeat);
		ticks.push(performance.now());
	}
	assert.ok(maximumGap(ticks) <= 100, "host heartbeat stalled during extension initialization");
});

test("interactive JSONL drainage discards oversized frames before parsing", async () => {
	const stream = Readable.from([`${"x".repeat(1_100_000)}\n{\"ok\":true}\n`]);
	const lines: string[] = [];
	let oversized = 0;
	const ended = new Promise<void>((resolve) => stream.once("end", resolve));
	attachJsonlLineReader(stream, (line) => lines.push(line), {
		maxLineChars: 1_048_576,
		maxLinesPerTurn: 64,
		onOversizedLine: () => { oversized += 1; },
	});
	await ended;
	assert.equal(oversized, 1);
	assert.deepEqual(lines, ['{\"ok\":true}']);
});
