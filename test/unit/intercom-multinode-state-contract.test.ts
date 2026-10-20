import assert from "node:assert/strict";
import { test } from "vitest";
import { reservationKeyFor } from "../../packages/intercom/broker/multinode-state-store.js";
import {
	registerBrokerLeaseStoreConformance,
	registerCrossNodeHeldRoundTripConformance,
	registerCrossNodeRoundTripConformance,
	registerHeldSendStoreConformance,
	registerOutboxStoreConformance,
	registerPendingAskStoreConformance,
	registerRestoringReservationStoreConformance,
	registerSentMessageAuthorityConformance,
	registerWakeUpBusConformance,
} from "../helpers/intercom-multinode-contract.js";
import {
	openMemoryHeldSendFixture,
	openMemoryLeaseStoreFixture,
	openMemoryOutboxFixture,
	openMemoryPendingAskFixture,
	openMemoryRestoringReservationFixture,
	openMemorySentMessageFixture,
	openMemoryWakeUpBusFixture,
} from "../helpers/intercom-multinode-memory-reference.js";

registerBrokerLeaseStoreConformance(test, "memory reference", openMemoryLeaseStoreFixture);
registerOutboxStoreConformance(test, "memory reference", openMemoryOutboxFixture);
registerHeldSendStoreConformance(test, "memory reference", openMemoryHeldSendFixture);
registerRestoringReservationStoreConformance(test, "memory reference", openMemoryRestoringReservationFixture);
registerPendingAskStoreConformance(test, "memory reference", openMemoryPendingAskFixture);
registerSentMessageAuthorityConformance(test, "memory reference", openMemorySentMessageFixture);
registerWakeUpBusConformance(test, "memory reference", openMemoryWakeUpBusFixture);
registerCrossNodeRoundTripConformance(test, "memory reference", {
	openOutbox: openMemoryOutboxFixture,
	openPendingAsks: openMemoryPendingAskFixture,
	openBus: openMemoryWakeUpBusFixture,
});
registerCrossNodeHeldRoundTripConformance(test, "memory reference", {
	openReservations: openMemoryRestoringReservationFixture,
	openHeldSends: openMemoryHeldSendFixture,
	openOutbox: openMemoryOutboxFixture,
	openBus: openMemoryWakeUpBusFixture,
});

test("reservationKeyFor is the lowercase hex SHA-256 of the capability, never the capability", () => {
	assert.equal(reservationKeyFor("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	const capability = "3f0c7a52-9b1e-4c6d-8f2a-1d4e5b6c7a8f.c2lnbmF0dXJl";
	const key = reservationKeyFor(capability);
	assert.match(key, /^[0-9a-f]{64}$/);
	assert.ok(!key.includes(capability.split(".")[0]!));
});
