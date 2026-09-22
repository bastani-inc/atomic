import { sessionScopedExtensionState } from "@bastani/atomic";
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
 * A reload candidate starts before its transaction commits and is only
 * published once its predecessor retires with `session_shutdown(reload)`,
 * which the host emits only after commit. A rolled-back candidate shuts down
 * while still pending, so runs never see it. `lifecycleScope` also spans
 * `/new`, `/fork`, and `/resume`, so only a `reload` start joins the current
 * host session; any other start begins a new one. Resolves `undefined` when
 * the host session has no committed generation left, and callers keep their
 * launch surface.
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
		const reload = typeof event === "object" && event !== null && "reason" in event && event.reason === "reload";
		hostSession = reload ? (state.current ?? []) : [];
		generation.modelContext = ctx;
		generation.committed = !hostSession.some((live) => live.committed);
		hostSession.push(generation);
		state.current = hostSession;
	});
	pi.on?.("session_shutdown", (event) => {
		const index = hostSession.indexOf(generation);
		if (index === -1) return;
		hostSession.splice(index, 1);
		const retiredAfterCommit =
			generation.committed &&
			typeof event === "object" &&
			event !== null &&
			"reason" in event &&
			event.reason === "reload";
		if (retiredAfterCommit) {
			for (const live of hostSession) live.committed = true;
		}
	});
	return () => hostSession.findLast((live) => live.committed);
}
