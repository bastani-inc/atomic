import { test } from "vitest";
import { BROKER_LEASE_STALE_AFTER_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import { REAL_BROKERS_TEST_TIMEOUT_MS, useSlowStoreBrokers } from "../helpers/intercom-away-routes-slow-store.js";
import { runConnectedCrashReplyScenario } from "./intercom-multinode-away-routes-slow-store-crash-connected-helpers.js";

/**
 * Asks between two connected sessions whose broker crashes, with a session coming back on the other broker (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

test(
	"an ask between two connected sessions survives its broker crashing and its asker coming back on the other broker: answered once, and its recipient's end adds nothing (#4997)",
	() => runConnectedCrashReplyScenario("asker"),
	REAL_BROKERS_TEST_TIMEOUT_MS + BROKER_LEASE_STALE_AFTER_MS,
);
