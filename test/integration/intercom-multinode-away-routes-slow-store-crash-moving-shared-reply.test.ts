import { test } from "vitest";
import { REAL_BROKERS_TEST_TIMEOUT_MS, useSlowStoreBrokers } from "../helpers/intercom-away-routes-slow-store.js";
import {
	AFTER_CRASH_DELIVERY_MS,
	runMovingCrashScenario,
} from "./intercom-multinode-away-routes-slow-store-crash-moving-helpers.js";

/**
 * Asks whose broker crashed while moving them, left in both local and shared state, answered by reply (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

test(
	"an ask its broker crashed while moving, left here and in the shared state, gets one outcome when its recipient replies and its asker comes back on the other broker (#4997)",
	() => runMovingCrashScenario("local-and-shared", "reply"),
	REAL_BROKERS_TEST_TIMEOUT_MS + AFTER_CRASH_DELIVERY_MS,
);
