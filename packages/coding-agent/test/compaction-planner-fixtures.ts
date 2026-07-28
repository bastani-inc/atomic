import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { CompactionRunRequest } from "../src/core/compaction/compaction-runner.ts";
import type { BorrowedPlanner, PlannerAuth } from "../src/core/compaction/compaction-types.ts";
import { resolvePlannerRequest } from "../src/core/compaction/range-planner.ts";

/** Build a session-model `BorrowedPlanner` for a direct planner call. */
export function planner(
	model: Model<Api>,
	thinkingLevel: ThinkingLevel | undefined,
	auth: PlannerAuth = { apiKey: "key" },
): BorrowedPlanner {
	return {
		model,
		budget: resolvePlannerRequest(model, thinkingLevel),
		auth,
	};
}

/** Build a `runVerbatimCompaction` request object with the defaults tests want. */
export function run(overrides: {
	streamFn: StreamFn;
	auth?: PlannerAuth | undefined;
	signal?: AbortSignal;
	thinkingLevel?: ThinkingLevel | undefined;
	urgency?: CompactionRunRequest["urgency"];
	fallback?: CompactionRunRequest["fallback"];
	retry?: CompactionRunRequest["retry"];
	callbacks?: CompactionRunRequest["callbacks"];
	sessionFilePath?: string;
}): CompactionRunRequest {
	const auth = "auth" in overrides ? overrides.auth : { apiKey: "key" };
	return {
		streamFn: overrides.streamFn,
		resolveAuth: async () => auth,
		signal: overrides.signal,
		thinkingLevel: "thinkingLevel" in overrides ? overrides.thinkingLevel : "off",
		urgency: overrides.urgency ?? "recoverable",
		...(overrides.fallback ? { fallback: overrides.fallback } : {}),
		...(overrides.retry ? { retry: overrides.retry } : {}),
		...(overrides.callbacks ? { callbacks: overrides.callbacks } : {}),
		...(overrides.sessionFilePath ? { sessionFilePath: overrides.sessionFilePath } : {}),
	};
}
