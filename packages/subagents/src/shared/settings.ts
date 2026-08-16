/** Shared behavior, progress, and task instruction helpers. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.js";
import type { OutputMode } from "./types.js";

const INITIAL_PROGRESS_CONTENT = "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n";

export interface ResolvedStepBehavior {
	output: string | false;
	outputMode: OutputMode;
	reads: string[] | false;
	progress: boolean;
	skills: string[] | false;
	model?: string;
}

export interface StepOverrides {
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skills?: string[] | false;
	model?: string;
}

function normalizeOutputOverride(output: string | false | undefined): string | false | undefined {
	return output === "false" ? false : output;
}

export function resolveStepBehavior(agentConfig: AgentConfig, stepOverrides: StepOverrides): ResolvedStepBehavior {
	const stepOutput = normalizeOutputOverride(stepOverrides.output);
	const output = stepOutput !== undefined ? stepOutput : (normalizeOutputOverride(agentConfig.output) ?? false);
	const reads = stepOverrides.reads !== undefined ? stepOverrides.reads : (agentConfig.defaultReads ?? false);
	const progress =
		stepOverrides.progress !== undefined ? stepOverrides.progress : (agentConfig.defaultProgress ?? false);

	let skills: string[] | false;
	if (stepOverrides.skills === false) skills = false;
	else if (stepOverrides.skills !== undefined) skills = [...stepOverrides.skills];
	else skills = agentConfig.skills ? [...agentConfig.skills] : [];

	const outputMode = stepOverrides.outputMode ?? "inline";
	const model = stepOverrides.model ?? agentConfig.model;
	return { output, outputMode, reads, progress, skills, model };
}

export function taskDisallowsFileUpdates(task: string | undefined): boolean {
	if (!task) return false;
	return (
		/\breview[- ]only\b/i.test(task) ||
		/\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task) ||
		/\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task) ||
		/\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task) ||
		/\bleave\s+files?\s+unchanged\b/i.test(task)
	);
}

export function suppressProgressForReadOnlyTask(
	behavior: ResolvedStepBehavior,
	task: string | undefined,
): ResolvedStepBehavior {
	return behavior.progress && taskDisallowsFileUpdates(task) ? { ...behavior, progress: false } : behavior;
}

export function resolveSingleProgress(
	agentConfig: AgentConfig,
	override: boolean | undefined,
	task: string | undefined,
): boolean {
	const behavior = resolveStepBehavior(agentConfig, { progress: override });
	return override !== undefined ? behavior.progress : suppressProgressForReadOnlyTask(behavior, task).progress;
}

export function buildReadInstruction(reads: string[] | false | undefined, cwd: string): string {
	if (!reads || reads.length === 0) return "";
	const files = reads.map((file) => path.resolve(cwd, file));
	return `[Read from: ${files.join(", ")}]`;
}

export function writeInitialProgressFile(progressDir: string): void {
	fs.mkdirSync(progressDir, { recursive: true });
	fs.writeFileSync(path.join(progressDir, "progress.md"), INITIAL_PROGRESS_CONTENT);
}

export function injectSingleProgressInstruction(task: string, progressDir: string): string {
	return `${task}\n\n---\nCreate and maintain progress at: ${path.join(progressDir, "progress.md")}`;
}

export function buildTaskInstructions(
	behavior: ResolvedStepBehavior,
	cwd: string,
	isFirstProgressAgent: boolean,
): { prefix: string; suffix: string } {
	const prefixParts: string[] = [];
	const suffixParts: string[] = [];
	const readInstruction = buildReadInstruction(behavior.reads, cwd);
	if (readInstruction) prefixParts.push(readInstruction);

	if (behavior.output) {
		const outputPath = path.isAbsolute(behavior.output) ? behavior.output : path.join(cwd, behavior.output);
		prefixParts.push(`[Write to: ${outputPath}]`);
	}

	if (behavior.progress) {
		const progressPath = path.join(cwd, "progress.md");
		if (isFirstProgressAgent) suffixParts.push(`Create and maintain progress at: ${progressPath}`);
		else suffixParts.push(`Update progress at: ${progressPath}`);
	}

	const prefix = prefixParts.length > 0 ? `${prefixParts.join("\n")}\n\n` : "";
	const suffix = suffixParts.length > 0 ? `\n\n---\n${suffixParts.join("\n")}` : "";
	return { prefix, suffix };
}

export type { ParallelTaskResult } from "../runs/shared/parallel-utils.js";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.js";
