import { poolStageUsageKey } from "../durable/journal/pool-stage-usage.js";
import type { PoolUsageReport } from "../durable/journal/sql-pool-usage.js";
import { meter_run } from "../shared/budget-meter.js";
import type { RunSnapshot } from "../shared/store-types.js";

export function collectWorkerUsage(runs: readonly RunSnapshot[]): PoolUsageReport[] {
	return runs.flatMap((run) =>
		run.stages
			.filter((stage) => stage.replayed !== true)
			.map((stage) => {
				const { perCounter, cost } = meter_run({ run: { ...run, stages: [stage] } }, 0);
				return { key: poolStageUsageKey(run.id, stage.id), usage: { ...perCounter, cost } };
			}),
	);
}
