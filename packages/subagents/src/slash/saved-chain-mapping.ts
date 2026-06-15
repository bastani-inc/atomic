import * as fs from "node:fs";
import * as path from "node:path";
import type { ChainConfig } from "../agents/agents.ts";
import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../shared/settings.ts";
import type { JsonSchemaObject } from "../shared/types.ts";

function loadSavedOutputSchema(
	chain: ChainConfig,
	_stepAgent: string,
	outputSchema: unknown,
): JsonSchemaObject | undefined {
	if (outputSchema === undefined) return undefined;
	if (typeof outputSchema === "string") {
		const schemaPath = path.isAbsolute(outputSchema)
			? outputSchema
			: path.join(path.dirname(chain.filePath), outputSchema);
		return JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as JsonSchemaObject;
	}
	return outputSchema as JsonSchemaObject;
}

export function mapSavedChainSteps(chain: ChainConfig, worktree = false): ChainStep[] {
	return (chain.steps as unknown as Array<ChainStep & { skills?: string[] | false }>).map((step) => {
		if (isParallelStep(step)) {
			const parallel = step.parallel.map((task) => {
				const { outputSchema: rawOutputSchema, ...rest } = task as typeof task & { outputSchema?: unknown };
				const outputSchema = loadSavedOutputSchema(chain, task.agent, rawOutputSchema);
				return { ...rest, ...(outputSchema ? { outputSchema } : {}) };
			});
			return { ...step, parallel, ...(worktree ? { worktree: true } : {}) };
		}
		if (isDynamicParallelStep(step)) {
			const { outputSchema: rawOutputSchema, ...parallelRest } = step.parallel as typeof step.parallel & { outputSchema?: unknown };
			const outputSchema = loadSavedOutputSchema(chain, step.parallel.agent, rawOutputSchema);
			const collectSchema = loadSavedOutputSchema(
				chain,
				`${step.collect.as} collection`,
				step.collect.outputSchema,
			);
			return {
				...step,
				parallel: { ...parallelRest, ...(outputSchema ? { outputSchema } : {}) },
				collect: { ...step.collect, ...(collectSchema ? { outputSchema: collectSchema } : {}) },
			};
		}
		const outputSchema = loadSavedOutputSchema(chain, step.agent, (step as { outputSchema?: unknown }).outputSchema);
		return {
			agent: step.agent,
			task: step.task || undefined,
			...(step.phase ? { phase: step.phase } : {}),
			...(step.label ? { label: step.label } : {}),
			...(step.as ? { as: step.as } : {}),
			...(outputSchema ? { outputSchema } : {}),
			output: step.output,
			outputMode: step.outputMode,
			reads: step.reads,
			progress: step.progress,
			skill: step.skill ?? step.skills,
			model: step.model,
		};
	});
}
