/**
 * Project workflow fixture for the full-feature workflow-heartbeat scenario
 * (issue #1975, all three slices, against a real provider).
 *
 * `scripts/e2e/workflow-heartbeat-live-evidence.sh` copies this file into a
 * scratch project's `.atomic/workflows/` and lets the real Atomic CLI discover
 * it, so it has to stay self-contained: no relative imports survive the copy.
 *
 * Separate from the two per-slice fixtures rather than an edit to either, so
 * their committed evidence stays reproducible.
 *
 * The run is one parked `ctx.tool` call. It makes no model call of its own —
 * the model turns in this scenario belong to the *parent chat* reacting to the
 * heartbeats, which is the behaviour under test. The park clears three
 * 1-minute boundaries and then completes on its own, landing between boundary 3
 * and boundary 4 so nothing is due at the instant the run ends.
 */

import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

/** Past boundary 3 (180s), well short of boundary 4 (240s). */
const PARK_MS = 200_000;

export default workflow({
	name: "workflow-heartbeat-live-evidence",
	description: "Parks and heartbeats at a 1-minute cadence so a live parent chat can react, then completes.",
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
