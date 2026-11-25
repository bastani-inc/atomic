import { test } from "vitest";
import { REAL_BROKERS_TEST_TIMEOUT_MS, useSlowStoreBrokers } from "../helpers/intercom-away-routes-slow-store.js";
import { runConnectedCrashEndScenario } from "./intercom-multinode-away-routes-slow-store-crash-connected-helpers.js";

/**
 * Asks between two connected sessions whose recipient ends after their broker crashed and a session moved (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

test(
	"an ask between two connected sessions fails once when its recipient ends after its broker crashed and its asker came back on the other broker (#4997)",
	() => runConnectedCrashEndScenario("asker"),
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an ask between two connected sessions fails once when its recipient ends after its broker crashed and its recipient came back on the other broker (#4997)",
	() => runConnectedCrashEndScenario("recipient"),
	REAL_BROKERS_TEST_TIMEOUT_MS,
);
