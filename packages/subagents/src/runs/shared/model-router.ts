import {
	AutoRoutingInferenceError,
	type ModelRoute as ExecutionModelRoute,
	type ExtensionContext,
	parseModelConstraints,
	routeExecutionModel,
} from "@bastani/atomic";
import type { AgentConfig } from "../../agents/agents.js";
import type { ModelConstraints } from "../../shared/model-constraints.js";
import { splitKnownThinkingSuffix, toModelInfo } from "../../shared/model-info.js";
import { resolveModelCandidate } from "./model-fallback.js";

export interface ModelRoute extends ExecutionModelRoute {
	allowsCandidate(candidate: string, defaultEffort?: string): boolean;
}

export async function routeSubagentModel(input: {
	ctx: ExtensionContext;
	agent: AgentConfig;
	task?: string;
	modelConstraints?: ModelConstraints;
	signal?: AbortSignal;
}): Promise<ModelRoute> {
	const { ctx, agent } = input;
	const constraints = structuredClone(
		[parseModelConstraints(agent.modelConstraints), parseModelConstraints(input.modelConstraints)].filter(
			(c): c is ModelConstraints => c !== undefined,
		),
	);
	const effortOverride = agent.source === "builtin" && agent.thinking !== "" ? agent.thinking : undefined;
	let route: ExecutionModelRoute;
	try {
		route = await routeExecutionModel({
			ctx,
			task: input.task?.trim() ? input.task : agent.systemPrompt,
			agent: { name: agent.name, description: agent.description },
			constraints:
				effortOverride === undefined ? constraints : [...constraints, { allowedEfforts: [effortOverride] }],
			signal: input.signal,
		});
	} catch (error) {
		input.signal?.throwIfAborted();
		// #3206: only a total routing-inference failure (Jev and the chat
		// structured-output fallback both failed) degrades, and only to a current
		// chat model that satisfies every routing constraint. Validation,
		// eligibility and ineligible-current-model failures still fail the launch.
		if (!(error instanceof AutoRoutingInferenceError) || error.currentModelRoute === undefined) throw error;
		route = error.currentModelRoute;
		console.warn(
			`Subagent auto routing failed; running "${agent.name}" on the current chat model ${route.modelOverride}.`,
		);
	}
	// Legacy thinking selects the primary effort, not a hard limit on suffixed fallbacks.
	// Restore the recorded selection against only real constraints, without another inference.
	const fallbackRoute =
		effortOverride === undefined
			? route
			: await routeExecutionModel({
					ctx,
					task: input.task?.trim() ? input.task : agent.systemPrompt,
					agent: { name: agent.name, description: agent.description },
					constraints,
					signal: input.signal,
					selection: route.routerSelection,
				});
	return {
		...route,
		allowsModel: fallbackRoute.allowsModel,
		allowsCandidate: (candidate, defaultEffort) => {
			const normalized = resolveModelCandidate(
				candidate,
				ctx.modelRegistry.getAvailable().map(toModelInfo),
				ctx.model?.provider,
			)!;
			const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(normalized);
			const model = ctx.modelRegistry.getAvailable().find((m) => `${m.provider}/${m.id}` === baseModel);
			return model !== undefined && fallbackRoute.allowsModel(model, thinkingSuffix.slice(1) || defaultEffort);
		},
	};
}
