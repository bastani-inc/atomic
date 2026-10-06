import { publishExtensionContextEffect, sessionScopedExtensionState } from "@bastani/atomic";
import type { ExtensionAPI } from "./public-types.js";
import type { WorkflowModelContext } from "./workflow-model-catalog.js";

export interface LiveHostGeneration {
	readonly pi: ExtensionAPI;
	modelContext: WorkflowModelContext | undefined;
	/** False while a reload candidate's transaction may still roll back. */
	committed: boolean;
}

interface LiveHostSessions {
	/** Live generations of the most recently started host session. */
	current?: LiveHostGeneration[];
}

/**
 * Track the newest committed extension load generation of one host session.
 *
 * A preserving `/reload` retires the generation that launched a run while the
 * run keeps executing (#2471). Everything that generation captured — its `pi`
 * facade and the launch command ctx — throws the stale-context error from
 * then on, so stage creation and the model catalog resolve the newest
 * committed generation of the same host session instead (#3201).
 *
 * A reload candidate joins while pending and is published synchronously at
 * transaction commit, before its predecessor loses authority. A rolled-back
 * candidate shuts down while still pending, so runs never see it. `lifecycleScope` also spans
 * `/new`, `/fork`, and `/resume`, which begin a new host session. Resolves
 * `undefined` when the host session has no committed generation left, and
 * callers keep their launch surface.
 */
export function trackLiveHostGeneration(pi: ExtensionAPI): () => LiveHostGeneration | undefined {
	const state = sessionScopedExtensionState<LiveHostSessions>(
		pi.lifecycleScope ?? pi.events ?? pi,
		"workflows:live-host-generation:v1",
		() => ({}),
	);
	const generation: LiveHostGeneration = { pi, modelContext: undefined, committed: false };
	let hostSession: LiveHostGeneration[] = [];
	pi.on?.("session_start", (event, ctx) => {
		const reason = typeof event === "object" && event !== null && "reason" in event ? event.reason : undefined;
		hostSession = reason === "reload" || reason === "startup" ? (state.current ?? []) : [];
		generation.modelContext = ctx;
		generation.committed = false;
		hostSession.push(generation);
		const start = () => {
			generation.committed = true;
			state.current = hostSession;
		};
		return ctx ? publishExtensionContextEffect(ctx, start, "commit") : start();
	});
	pi.on?.("session_shutdown", () => {
		const index = hostSession.indexOf(generation);
		if (index !== -1) hostSession.splice(index, 1);
	});
	return () => hostSession.findLast((live) => live.committed);
}
