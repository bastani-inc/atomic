import { test } from "vitest";
import {
	CRASH_TEST_TIMEOUT_MS,
	runDepartureCrashScenario,
	SWEPT_WITHIN_MS,
	useEndedRecipientCrashBrokers,
} from "./intercom-multinode-ended-recipient-crash-helpers.js";

useEndedRecipientCrashBrokers();

test(
	"an asker on another broker gets its failure once when the ended recipient's broker crashes 300 ms into the departure (#4992)",
	() => runDepartureCrashScenario(300),
	CRASH_TEST_TIMEOUT_MS + SWEPT_WITHIN_MS,
);
