import { test } from "vitest";
import { explicitRestartAdmitsLocalResources, TWO_POOLS } from "../helpers/workflow-local-pool-lifecycle.js";

/** Explicit restart from quit or paused, with the child's result not yet cached (cached=false). */

test.each([
	{ state: "quit", cached: false },
	{ state: "paused", cached: false },
] as const)(
	"explicit restart from $state admits local resources before child dispatch, cached=$cached (#3869)",
	explicitRestartAdmitsLocalResources,
	TWO_POOLS.timeoutMs,
);
