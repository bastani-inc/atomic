/**
 * Project workflow fixture for the workflow-heartbeat end-to-end scenario
 * (issue #1975, slice 2).
 *
 * `scripts/e2e/workflow-heartbeat-evidence.sh` copies this file into a scratch
 * project's `.atomic/workflows/` and lets the real Atomic CLI discover it, so it
 * has to stay self-contained: no relative imports survive the copy.
 *
 * The run is one long-parked `ctx.tool` call and nothing else. No model call is
 * made, so the scenario runs under `--offline`, and the run stays active well
 * past the first cadence boundary without any timer of its own deciding when
 * that boundary arrives — the scheduler does, from the run's persisted start
 * time.
 *
 * `heartbeatIntervalMinutes: 1` is the shortest whole-minute cadence, so the
 * first heartbeat is due 60 seconds after the run starts.
 */

import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

/** Long enough to cover two 1-minute boundaries with room to spare. */
const PARK_MS = 240_000;

export default workflow({
	name: "workflow-heartbeat-evidence",
	description: "Parks on a tool call so the heartbeat cadence can be observed in the main chat.",
	heartbeatIntervalMinutes: 1,
	inputs: {},
	outputs: { parked: Type.String() },
	run: async (ctx) => {
		const parked = await ctx.tool("park-tool", {}, async (toolContext) => {
			const signal: AbortSignal | undefined = toolContext?.signal;
			return await new Promise<string>((resolve) => {
				const timer = setTimeout(() => resolve("parked-until-timeout"), PARK_MS);
				if (signal === undefined) return;
				const cancel = (): void => {
					clearTimeout(timer);
					resolve("parked-until-abort");
				};
				if (signal.aborted) {
					cancel();
					return;
				}
				signal.addEventListener("abort", cancel, { once: true });
			});
		});
		return { parked };
	},
});
