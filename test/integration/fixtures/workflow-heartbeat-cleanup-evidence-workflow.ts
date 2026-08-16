/**
 * Project workflow fixture for the workflow-heartbeat terminal-cleanup
 * end-to-end scenario (issue #1975, slice 3).
 *
 * `scripts/e2e/workflow-heartbeat-cleanup-evidence.sh` copies this file into a
 * scratch project's `.atomic/workflows/` and lets the real Atomic CLI discover
 * it, so it has to stay self-contained: no relative imports survive the copy.
 *
 * Deliberately a separate fixture from `workflow-heartbeat-evidence-workflow.ts`
 * rather than an edit to it, so slice 2's evidence stays reproducible.
 *
 * The run is one parked `ctx.tool` call and nothing else. No model call is made,
 * so the scenario runs under `--offline`. The park is long enough for at least
 * two 1-minute boundaries to be delivered, then the run **completes on its own**
 * — no keystroke, no kill — which is the terminal transition the scenario is
 * about. It lands between boundary 3 and boundary 4, so nothing is due at the
 * instant the run ends and the observed count is unambiguous.
 */

import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

/** Past boundary 3 (180s) and well short of boundary 4 (240s). */
const PARK_MS = 200_000;

export default workflow({
	name: "workflow-heartbeat-cleanup-evidence",
	description: "Parks, heartbeats, then completes, so heartbeat cleanup at a terminal state can be observed.",
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
