import * as fs from "node:fs";
import { appendJsonl } from "../../shared/artifacts.ts";
import { isDynamicRunnerGroup, isParallelGroup } from "../shared/parallel-utils.ts";
import { runDynamicGroup } from "./subagent-runner-dynamic.ts";
import { finalizeRun } from "./subagent-runner-finalize.ts";
import { runParallelGroup } from "./subagent-runner-parallel.ts";
import { runSequentialStep } from "./subagent-runner-sequential.ts";
import { createRunnerExecutionState, interruptRunner, startActivityTimer } from "./subagent-runner-state.ts";
import type { SubagentRunConfig, SubagentStep } from "./subagent-runner-types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

async function runSubagent(config: SubagentRunConfig): Promise<void> {
	const state = createRunnerExecutionState(config);
	startActivityTimer(state);
	const onInterrupt = () => interruptRunner(state);
	process.on(ASYNC_INTERRUPT_SIGNAL, onInterrupt);
	appendJsonl(state.eventsPath, JSON.stringify({
		type: "subagent.run.started",
		ts: state.overallStartTime,
		runId: state.id,
		mode: state.statusPayload.mode,
		cwd: state.cwd,
		pid: process.pid,
	}));

	try {
		for (let stepIndex = 0; stepIndex < state.steps.length; stepIndex++) {
			if (state.interrupted) break;
			const step = state.steps[stepIndex];
			let shouldContinue = true;
			if (isDynamicRunnerGroup(step)) {
				shouldContinue = await runDynamicGroup(state, step, stepIndex);
			} else if (isParallelGroup(step)) {
				shouldContinue = await runParallelGroup(state, step, stepIndex);
			} else {
				shouldContinue = await runSequentialStep(state, step as SubagentStep, stepIndex);
			}
			if (!shouldContinue) break;
		}
		await finalizeRun(state);
	} finally {
		process.off(ASYNC_INTERRUPT_SIGNAL, onInterrupt);
	}
}

function parseConfig(input: string): SubagentRunConfig {
	return JSON.parse(input) as SubagentRunConfig;
}

function runConfig(config: SubagentRunConfig): void {
	runSubagent(config).catch((runErr) => {
		console.error("Subagent runner error:", runErr);
		process.exit(1);
	});
}

const configArg = process.argv[2];
if (configArg) {
	try {
		const configJson = fs.readFileSync(configArg, "utf-8");
		const config = parseConfig(configJson);
		try {
			fs.unlinkSync(configArg);
		} catch {
			// Temp config cleanup is best effort.
		}
		runConfig(config);
	} catch (err) {
		console.error("Subagent runner error:", err);
		process.exit(1);
	}
} else {
	let input = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
	});
	process.stdin.on("end", () => {
		try {
			runConfig(parseConfig(input));
		} catch (err) {
			console.error("Subagent runner error:", err);
			process.exit(1);
		}
	});
}
