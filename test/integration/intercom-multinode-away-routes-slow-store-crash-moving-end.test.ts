import { test } from "vitest";
import { REAL_BROKERS_TEST_TIMEOUT_MS, useSlowStoreBrokers } from "../helpers/intercom-away-routes-slow-store.js";
import {
	AFTER_CRASH_DELIVERY_MS,
	runMovingCrashScenario,
} from "./intercom-multinode-away-routes-slow-store-crash-moving-helpers.js";

/**
 * Asks whose broker crashed while moving them, left locally or in shared state too, whose recipient ends (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

test(
	"an ask its broker crashed while moving, left only here, gets one outcome when its recipient ends and its asker comes back on the other broker (#4997)",
	() => runMovingCrashScenario("local", "end"),
	REAL_BROKERS_TEST_TIMEOUT_MS + AFTER_CRASH_DELIVERY_MS,
);

test(
	"an ask its broker crashed while moving, left here and in the shared state, gets one outcome when its recipient ends and its asker comes back on the other broker (#4997)",
	() => runMovingCrashScenario("local-and-shared", "end"),
	REAL_BROKERS_TEST_TIMEOUT_MS + AFTER_CRASH_DELIVERY_MS,
);
