import type { ModelRoute } from "@bastani/atomic";
import type { WorkflowModelCatalogPort } from "../../shared/types.js";
import { ConcurrencyLimiter } from "../shared/concurrency.js";

/** Most routing inferences the process runs at once across every stage; the rest wait for a slot. */
export const STAGE_ROUTING_CONCURRENCY = 8;

/** Longest a stage waits for model routing, queue wait included, before routing ends like a total inference failure. */
export const STAGE_ROUTING_DEADLINE_MS = 300_000;

const routingLimiter = new ConcurrencyLimiter(STAGE_ROUTING_CONCURRENCY);

type RouteModel = NonNullable<WorkflowModelCatalogPort["routeModel"]>;

export async function routeStageModel(route: RouteModel, input: Parameters<RouteModel>[0]): Promise<ModelRoute> {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("stage routing deadline")), STAGE_ROUTING_DEADLINE_MS);
	try {
		return await route({
			...input,
			inference: { deadline: deadline.signal, limit: (run, signal) => routingLimiter.run(run, signal) },
		});
	} finally {
		clearTimeout(timer);
	}
}
