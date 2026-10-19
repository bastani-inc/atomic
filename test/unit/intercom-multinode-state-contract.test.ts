import { test } from "vitest";
import {
	registerBrokerLeaseStoreConformance,
	registerCrossNodeRoundTripConformance,
	registerHeldSendStoreConformance,
	registerOutboxStoreConformance,
	registerPendingAskStoreConformance,
	registerSentMessageAuthorityConformance,
	registerWakeUpBusConformance,
} from "../helpers/intercom-multinode-contract.js";
import {
	openMemoryHeldSendFixture,
	openMemoryLeaseStoreFixture,
	openMemoryOutboxFixture,
	openMemoryPendingAskFixture,
	openMemorySentMessageFixture,
	openMemoryWakeUpBusFixture,
} from "../helpers/intercom-multinode-memory-reference.js";

registerBrokerLeaseStoreConformance(test, "memory reference", openMemoryLeaseStoreFixture);
registerOutboxStoreConformance(test, "memory reference", openMemoryOutboxFixture);
registerHeldSendStoreConformance(test, "memory reference", openMemoryHeldSendFixture);
registerPendingAskStoreConformance(test, "memory reference", openMemoryPendingAskFixture);
registerSentMessageAuthorityConformance(test, "memory reference", openMemorySentMessageFixture);
registerWakeUpBusConformance(test, "memory reference", openMemoryWakeUpBusFixture);
registerCrossNodeRoundTripConformance(test, "memory reference", {
	openOutbox: openMemoryOutboxFixture,
	openPendingAsks: openMemoryPendingAskFixture,
	openBus: openMemoryWakeUpBusFixture,
});
