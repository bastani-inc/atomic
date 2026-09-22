import { sessionScopedExtensionState } from "@bastani/atomic";
import type { ExtensionAPI } from "./public-types.js";
import type { WorkflowModelContext } from "./workflow-model-catalog.js";

export interface LiveHostGeneration {
	readonly pi: ExtensionAPI;
	modelContext: WorkflowModelContext | undefined;
}

interface LiveHostGenerations {
	readonly generations: LiveHostGeneration[];
}

/**
 * Track the newest live extension load generation of one host session.
 *
 * A preserving `/reload` retires the generation that launched a run while the
 * run keeps executing (#2471). Everything that generation captured — its `pi`
 * facade and the launch command ctx — throws the stale-context error from
 * then on, so stage creation and the model catalog resolve the newest
 * generation through this session-scoped list instead (#3201). A generation
 * leaves the list at its `session_shutdown`, which also hands a rolled-back
 * transactional reload back to its still-live predecessor.
 */
export function trackLiveHostGeneration(pi: ExtensionAPI): () => LiveHostGeneration {
	const state = sessionScopedExtensionState<LiveHostGenerations>(
		pi.lifecycleScope ?? pi.events ?? pi,
		"workflows:live-host-generation:v1",
		() => ({ generations: [] }),
	);
	const generation: LiveHostGeneration = { pi, modelContext: undefined };
	state.generations.push(generation);
	pi.on?.("session_start", (_event, ctx) => {
		generation.modelContext = ctx;
	});
	pi.on?.("session_shutdown", () => {
		const index = state.generations.indexOf(generation);
		if (index !== -1) state.generations.splice(index, 1);
	});
	return () => state.generations.at(-1) ?? generation;
}
