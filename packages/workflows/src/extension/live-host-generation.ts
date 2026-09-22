import { sessionScopedExtensionState } from "@bastani/atomic";
import type { ExtensionAPI } from "./public-types.js";
import type { WorkflowModelContext } from "./workflow-model-catalog.js";

export interface LiveHostGeneration {
	readonly pi: ExtensionAPI;
	modelContext: WorkflowModelContext | undefined;
}

interface LiveHostSessions {
	/** Live generations of the most recently started host session. */
	current?: LiveHostGeneration[];
}

/**
 * Track the newest live extension load generation of one host session.
 *
 * A preserving `/reload` retires the generation that launched a run while the
 * run keeps executing (#2471). Everything that generation captured — its `pi`
 * facade and the launch command ctx — throws the stale-context error from
 * then on, so stage creation and the model catalog resolve the newest
 * generation of the same host session instead (#3201). `lifecycleScope` also
 * spans `/new`, `/fork`, and `/resume`, so only a `reload` start joins the
 * current host session; any other start begins a new one. A generation leaves
 * its host session at `session_shutdown`, which also hands a rolled-back
 * transactional reload back to its still-live predecessor. Resolves
 * `undefined` when the host session has no live generation left, and callers
 * keep their launch surface.
 */
export function trackLiveHostGeneration(pi: ExtensionAPI): () => LiveHostGeneration | undefined {
	const state = sessionScopedExtensionState<LiveHostSessions>(
		pi.lifecycleScope ?? pi.events ?? pi,
		"workflows:live-host-generation:v1",
		() => ({}),
	);
	const generation: LiveHostGeneration = { pi, modelContext: undefined };
	let hostSession: LiveHostGeneration[] = [];
	pi.on?.("session_start", (event, ctx) => {
		const reload = typeof event === "object" && event !== null && "reason" in event && event.reason === "reload";
		hostSession = reload ? (state.current ?? []) : [];
		generation.modelContext = ctx;
		hostSession.push(generation);
		state.current = hostSession;
	});
	pi.on?.("session_shutdown", () => {
		const index = hostSession.indexOf(generation);
		if (index !== -1) hostSession.splice(index, 1);
	});
	return () => hostSession.at(-1);
}
