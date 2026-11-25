import { test } from "vitest";
import {
	runLostRecipientUnavailableScenario,
	TEST_TIMEOUT_MS,
	useLostRecipientEndBrokers,
} from "./intercom-multinode-lost-recipient-end-helpers.js";

useLostRecipientEndBrokers();

test(
	"an asker is told once that its recipient is unavailable when the recipient's broker is killed 0 ms into its departure (#5154)",
	() => runLostRecipientUnavailableScenario(0),
	TEST_TIMEOUT_MS,
);
