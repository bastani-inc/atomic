import type { PoolUsage, PoolUsageReport } from "../durable/journal/sql-pool-usage.js";
import { meter_run } from "../shared/budget-meter.js";
import type { RunSnapshot } from "../shared/store-types.js";

export function collectWorkerUsage(runs: readonly RunSnapshot[]): PoolUsageReport[] {
	return runs.map((run) => {
		const { perCounter, cost } = meter_run({ run }, 0);
		const usage: PoolUsage = { ...perCounter, cost };
		return { key: run.id, usage };
	});
}
