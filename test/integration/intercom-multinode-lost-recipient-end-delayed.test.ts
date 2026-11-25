import { test } from "vitest";
import {
	runLostRecipientUnavailableScenario,
	TEST_TIMEOUT_MS,
	useLostRecipientEndBrokers,
} from "./intercom-multinode-lost-recipient-end-helpers.js";

useLostRecipientEndBrokers();

test(
	"an asker is told once that its recipient is unavailable when the recipient's broker is killed 50 ms into its departure (#5154)",
	() => runLostRecipientUnavailableScenario(50),
	TEST_TIMEOUT_MS,
);

test(
	"an asker is told once that its recipient is unavailable when the recipient's broker is killed 100 ms into its departure (#5154)",
	() => runLostRecipientUnavailableScenario(100),
	TEST_TIMEOUT_MS,
);
