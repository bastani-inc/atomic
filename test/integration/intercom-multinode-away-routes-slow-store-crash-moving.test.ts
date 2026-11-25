import { test } from "vitest";
import { REAL_BROKERS_TEST_TIMEOUT_MS, useSlowStoreBrokers } from "../helpers/intercom-away-routes-slow-store.js";
import {
	AFTER_CRASH_DELIVERY_MS,
	runMovingCrashScenario,
} from "./intercom-multinode-away-routes-slow-store-crash-moving-helpers.js";

/**
 * Asks whose broker crashed while moving them, left on the crashed broker or in the shared state too (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

test(
	"an ask its broker crashed while moving, left only here, gets one outcome when its recipient replies and its asker comes back on the other broker (#4997)",
	() => runMovingCrashScenario("local", "reply"),
	REAL_BROKERS_TEST_TIMEOUT_MS + AFTER_CRASH_DELIVERY_MS,
);
