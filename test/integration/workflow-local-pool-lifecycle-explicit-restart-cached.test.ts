import { test } from "vitest";
import { explicitRestartAdmitsLocalResources, TWO_POOLS } from "../helpers/workflow-local-pool-lifecycle.js";

/** Explicit restart from quit or paused, with the child's result already cached (cached=true). */

test.each([
	{ state: "quit", cached: true },
	{ state: "paused", cached: true },
] as const)(
	"explicit restart from $state admits local resources before child dispatch, cached=$cached (#3869)",
	explicitRestartAdmitsLocalResources,
	TWO_POOLS.timeoutMs,
);
