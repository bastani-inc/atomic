import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { ActivityWatchdogDiagnostic } from "../../packages/coding-agent/src/modes/interactive-engine/activity-watchdog.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { attachJsonlLineReader } from "../../packages/coding-agent/src/modes/rpc/jsonl.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

function maximumGap(timestamps: readonly number[]): number {
	let maximum = 0;
	for (let index = 1; index < timestamps.length; index += 1) {
		maximum = Math.max(maximum, timestamps[index]! - timestamps[index - 1]!);
	}
	return maximum;
}

const REAL_ENGINE_ISOLATION_TEST_TIMEOUT_MS = 120_000;

test.sequential(
	"the real agent path isolates a blocking extension tool and reports its child PID",
	async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-isolation-"));
		const pidFile = join(tempDir, "tool.pid");
		const heartbeatTimes: number[] = [performance.now()];
		let inputTicks = 0;
		let renderTicks = 0;
		const heartbeat = setInterval(() => heartbeatTimes.push(performance.now()), 10);
		const input = setInterval(() => {
			inputTicks += 1;
		}, 20);
		const render = setInterval(() => {
			renderTicks += 1;
		}, 16);
		let resolveDiagnostic!: (diagnostic: ActivityWatchdogDiagnostic) => void;
		const diagnosticPromise = new Promise<ActivityWatchdogDiagnostic>((resolve) => {
			resolveDiagnostic = resolve;
		});
		const onDiagnostic = (diagnostic: ActivityWatchdogDiagnostic): void => {
			// Under parallel load a child can report an earlier blocking lifecycle
			// diagnostic without an activity. This test is specifically about the
			// watchdog's tool.execute activity, so ignore unrelated diagnostics rather
			// than resolving the promise on whichever one wins the race.
			if (diagnostic.level === "blocking" && diagnostic.activity?.kind === "tool.execute") {
				resolveDiagnostic(diagnostic);
			}
		};
		const client = new RpcClient({
			cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
			cwd: join(moduleDir(import.meta.url), "../.."),
			runtimeExecutable: bunExecutable(),
			provider: "isolation-fixture",
			model: "blocking-model",
			env: { ATOMIC_BLOCKING_TOOL_PID_FILE: pidFile },
			args: [
				"--no-session",
				"--no-extensions",
				"--extension",
				join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts"),
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--offline",
			],
			interactiveEngine: { onDiagnostic },
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
			assert.notEqual(
				Number(readFileSync(pidFile, "utf8")),
				process.pid,
				"tool callback ran in the TUI host process",
			);
			const inputAtDiagnostic = inputTicks;
			const rendersAtDiagnostic = renderTicks;
			await sleep(150);
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
	},
	REAL_ENGINE_ISOLATION_TEST_TIMEOUT_MS,
);

test("remote custom components render and receive input through the engine protocol", async () => {
	const output: string[] = [];
	const service = new EngineCustomUiService((line) => output.push(line), new KeybindingsManager());
	const result = service.custom<string>((_tui, _theme, _keybindings, done) => ({
		render: (width) => [`width:${width},rows:${_tui.terminal.rows}`],
		handleInput: (data) => {
			if (data !== "\r") return false;
			done("accepted");
			return true;
		},
		invalidate: () => {},
	}));
	await sleep(0);
	const open = output.map(parseInteractiveEngineMessage).find((message) => message?.type === "engine_custom_open");
	assert.ok(open?.type === "engine_custom_open");
	service.handleLine(
		serializeInteractiveEngineFrame({
			type: "engine_custom_render",
			componentId: open.componentId,
			requestId: 1,
			width: 72,
			rows: 40,
		}),
	);
	await sleep(0);
	const frame = output.map(parseInteractiveEngineMessage).find((message) => message?.type === "engine_custom_frame");
	assert.ok(frame?.type === "engine_custom_frame");
	assert.deepEqual(frame.lines, ["width:72,rows:40"]);
	service.handleLine(
		serializeInteractiveEngineFrame({
			type: "engine_custom_input",
			componentId: open.componentId,
			requestId: 1,
			data: "\r",
		}),
	);
	assert.equal(await result, "accepted");
	service.dispose();
});

test.sequential("startup custom UI can unblock engine binding after transport readiness", async () => {
	const client = new RpcClient({
		cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
		cwd: join(moduleDir(import.meta.url), "../.."),
		runtimeExecutable: bunExecutable(),
		provider: "isolation-fixture",
		model: "blocking-model",
		env: { ATOMIC_STARTUP_CUSTOM_UI: "1" },
		args: [
			"--no-session",
			"--no-extensions",
			"--extension",
			join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts"),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
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
		client.sendInteractiveEngineCommand({
			type: "engine_custom_input",
			componentId: open.componentId,
			requestId: 1,
			data: "\r",
		});
		await Promise.race([
			client.waitForInteractiveEngineBound(),
			sleep(2_000).then(() => {
				throw new Error("engine binding did not resume after startup custom UI");
			}),
		]);
	} finally {
		await client.stop();
	}
});

test.sequential(
	"blocking extension initialization cannot delay creation of the interactive host",
	async () => {
		const ticks: number[] = [performance.now()];
		const heartbeat = setInterval(() => ticks.push(performance.now()), 10);
		let resolveDiagnostic!: (diagnostic: ActivityWatchdogDiagnostic) => void;
		const diagnosticPromise = new Promise<ActivityWatchdogDiagnostic>((resolve) => {
			resolveDiagnostic = resolve;
		});
		const client = new RpcClient({
			cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
			cwd: join(moduleDir(import.meta.url), "../.."),
			runtimeExecutable: bunExecutable(),
			provider: "isolation-fixture",
			model: "blocking-model",
			env: { ATOMIC_BLOCKING_EXTENSION_INIT: "1" },
			args: [
				"--no-session",
				"--no-extensions",
				"--extension",
				join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts"),
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--offline",
			],
			interactiveEngine: { onDiagnostic: resolveDiagnostic },
		});
		try {
			let bound = false;
			// `start()` initializes the monitor synchronously before awaiting
			// engine_ready, so capture engine_bound concurrently. The invariant we
			// care about is ordering, not an OS-specific absolute spawn budget:
			// host readiness MUST resolve while the deliberately blocking extension
			// initialization is still pending.
			const startPromise = client.start();
			const boundPromise = client.waitForInteractiveEngineBound().then(() => {
				bound = true;
			});
			await startPromise;
			assert.equal(bound, false, "host creation waited for blocking extension initialization");
			const diagnostic = await diagnosticPromise;
			assert.equal(diagnostic.level, "blocking");
			await boundPromise;
		} finally {
			await client.stop();
			clearInterval(heartbeat);
			ticks.push(performance.now());
		}
		assert.ok(maximumGap(ticks) <= 100, "host heartbeat stalled during extension initialization");
	},
	REAL_ENGINE_ISOLATION_TEST_TIMEOUT_MS,
);

test("interactive JSONL drainage preserves frames larger than 1 MiB", async () => {
	const large = "x".repeat(1_100_000);
	const stream = Readable.from([`${large}\n{"ok":true}\n`]);
	const lines: string[] = [];
	await new Promise<void>((resolve) => {
		attachJsonlLineReader(
			stream,
			(line) => {
				lines.push(line);
				if (lines.length === 2) resolve();
			},
			{ maxBytesPerTurn: 64 * 1024, maxLinesPerTurn: 64 },
		);
	});
	assert.equal(lines[0], large);
	assert.equal(lines[1], '{"ok":true}');
});
