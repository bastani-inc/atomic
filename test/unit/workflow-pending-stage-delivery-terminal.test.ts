/**
 * Terminal settlement of the workflow pending-stage delivery contract.
 *
 * `stage-runner-controller` awaits `pendingStageDelivery.ready()` with no
 * timeout, and only a successful drain ever resolved it. When the Intercom
 * wrapper exhausts its bounded warm-up retries there is no owner left, so the
 * delivery needs a terminal signal: `fail(reason)` settles `ready()` exactly
 * once with a typed, stage-scoped error instead of leaving the stage parked.
 *
 * The queued entries themselves are never consumed by a stage that was already
 * failed closed — a delivery asked to drain after the latch is a silent no-op,
 * so the steering stays queued rather than being marked delivered to a stage
 * that will not read it.
 *
 * The terminal error must also not read as a *model* failure. Intercom's reason
 * nests the transport error that lost the broker, so chaining it as `cause` let
 * the shared classifier's cause walk latch `code: "ECONNRESET"` and call a dead
 * delivery a retryable `network_timeout`.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { IntercomWarmUpExhaustedError } from "../../packages/intercom/warm-up-exhaustion.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	createWorkflowPendingStageDelivery,
	isWorkflowPendingStageDeliveryFailure,
	WorkflowPendingStageDeliveryFailedError,
} from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
} from "../../packages/workflows/src/runs/shared/model-fallback-failures.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessageInput } from "../../packages/workflows/src/shared/store-types.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";

/** The exact reason chain `packages/intercom/index.ts` hands to `fail()` in production. */
function productionWarmUpExhaustedReason(): IntercomWarmUpExhaustedError {
	const transport = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
	return new IntercomWarmUpExhaustedError(5, { cause: new IntercomClientDisconnectedError({ cause: transport }) });
}

const RUN_ID = testRunId("terminal-delivery");
const GROUP = `workflow:${RUN_ID}`;
const STAGE_ID = "reviewer-id";
const STAGE_NAME = "reviewer";

afterEach(() => setDurableBackend(undefined));

function fixture() {
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [{ id: STAGE_ID, name: STAGE_NAME, status: "pending", parentIds: [], toolEvents: [] }],
		startedAt: 1,
	});
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	return { store, backend };
}

function queuedInput(id: string): PendingStageMessageInput {
	return {
		runId: RUN_ID,
		stageKey: STAGE_NAME,
		from: { id: "planner-session", name: "planner", group: GROUP },
		message: { id, timestamp: 1_725_000_000_000, content: { text: `steering ${id}` } },
		queuedAt: "2026-09-04T00:00:00.000Z",
	};
}

async function fixtureWithQueuedMessage(id = "queued-1") {
	const { store, backend } = fixture();
	const queued = await store.queueStageMessage(queuedInput(id), GROUP, GROUP, backend);
	assert.equal(queued?.ok, true);
	return { store, backend };
}

describe("workflow pending-stage delivery terminal failure", () => {
	test("rejects a ready() that was already awaited when the delivery owner gives up", async () => {
		const { store } = await fixtureWithQueuedMessage();
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		const parked = delivery.ready();
		assert.ok(parked instanceof Promise, "a stage with queued messages parks on ready()");
		delivery.fail(new Error("Intercom could not reach the broker after 5 warm-up attempts."));

		await assert.rejects(parked, (error: unknown) => {
			assert.ok(error instanceof WorkflowPendingStageDeliveryFailedError);
			assert.equal(error.code, "pending_stage_delivery_failed");
			assert.equal(error.runId, RUN_ID);
			assert.equal(error.stageId, STAGE_ID);
			assert.equal(error.stageName, STAGE_NAME);
			assert.match(error.message, /stage "reviewer"/);
			assert.match(error.message, /reviewer-id/);
			assert.match(error.message, /Intercom could not reach the broker after 5 warm-up attempts\./);
			assert.equal(error.reason.message, "Intercom could not reach the broker after 5 warm-up attempts.");
			assert.equal(error.cause, undefined, "the reason is deliberately not chained as `cause`");
			return true;
		});
	});

	test("rejects a ready() requested after the failure was already latched", async () => {
		// The wrapper's `session_start` handler returns as soon as it schedules the
		// retry, so the terminal signal can arrive before the controller ever calls
		// `ready()`. A latch that only rejected an existing promise would be a
		// silent no-op in that ordering.
		const { store } = await fixtureWithQueuedMessage();
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		delivery.fail(new Error("Intercom could not reach the broker after 5 warm-up attempts."));

		await assert.rejects(
			delivery.ready() as Promise<void>,
			(error: unknown) => error instanceof WorkflowPendingStageDeliveryFailedError,
		);
	});

	test("keeps the empty-queue short circuit so a stage with nothing queued still runs", async () => {
		const { store } = fixture();
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		assert.equal(delivery.ready(), undefined);
		delivery.fail(new Error("Intercom could not reach the broker after 5 warm-up attempts."));

		assert.equal(delivery.ready(), undefined, "nothing was queued, so nothing is lost by running the stage");
	});

	test("settles exactly once: the first reason wins and a duplicate fail() is a no-op", async () => {
		const { store } = await fixtureWithQueuedMessage();
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		delivery.fail(new Error("first reason"));
		delivery.fail(new Error("second reason"));

		const first = await delivery.ready()?.then(
			() => undefined,
			(error: Error) => error,
		);
		const second = await delivery.ready()?.then(
			() => undefined,
			(error: Error) => error,
		);
		assert.ok(first instanceof WorkflowPendingStageDeliveryFailedError);
		assert.match(first.message, /first reason/);
		assert.equal(second, first, "every later ready() settles with the same terminal error");
	});

	test("a late deliverPending() after the failure leaves the queued steering untouched", async () => {
		const { store } = await fixtureWithQueuedMessage("late-1");
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		delivery.fail(new Error("Intercom could not reach the broker after 5 warm-up attempts."));
		const delivered: string[] = [];
		await delivery.deliverPending((_from, message) => {
			delivered.push(message.id);
		});

		assert.deepEqual(delivered, [], "a failed-closed stage never consumes the entries it was refused");
		const queued = store.pendingStageMessagesFor(RUN_ID, STAGE_NAME);
		assert.equal(queued.length, 1);
		assert.equal(queued[0]?.status, "queued");
	});

	test("delivers normally when no failure was latched", async () => {
		const { store } = await fixtureWithQueuedMessage("healthy-1");
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		const parked = delivery.ready();
		const delivered: string[] = [];
		await delivery.deliverPending((_from, message) => {
			delivered.push(message.id);
		});
		await parked;

		assert.deepEqual(delivered, ["healthy-1"]);
		const entries = store.runs().find((entry) => entry.id === RUN_ID)?.pendingStageMessages;
		assert.equal(entries?.[0]?.status, "delivered");
	});

	test("a terminal failure nobody awaited raises no unhandled rejection", async () => {
		const { store } = await fixtureWithQueuedMessage("orphan-1");
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);
		const rejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			// The controller may not have reached its `await` yet — production must
			// not turn that race into a process-level unhandled rejection.
			void delivery.ready();
			delivery.fail(new Error("Intercom could not reach the broker after 5 warm-up attempts."));
			await sleep(50);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		assert.deepEqual(rejections, []);
	});

	test("is refused by the shared model-failure classifier even on the production reason chain", async () => {
		// Regression: `{ cause: reason }` let `structuredSignal`'s cause walk reach
		// the transport error's `code: "ECONNRESET"` and classify a dead delivery as
		// `network_timeout` — same-model retryable and fallback-eligible — so every
		// candidate was spent on a stage that could never receive its instructions.
		const { store } = await fixtureWithQueuedMessage("classify-1");
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);
		const reason = productionWarmUpExhaustedReason();

		delivery.fail(reason);
		const terminal = await delivery.ready()?.then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(terminal instanceof WorkflowPendingStageDeliveryFailedError);
		assert.equal(terminal.reason, reason, "the production reason is still reachable for diagnosis");
		assert.equal(isRetryableSameModelFailure(terminal), false, "no same-model retry is spent");
		assert.equal(isRetryableModelFailure(terminal), false, "no model-fallback candidate is spent");
		assert.equal(isWorkflowPendingStageDeliveryFailure(terminal), true);
	});

	test("blocks resumably when queued instructions cannot be delivered (#3628)", async () => {
		const { store } = await fixtureWithQueuedMessage("resume-1");
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);
		delivery.fail(productionWarmUpExhaustedReason());
		const error = await delivery.ready()?.catch((reason: Error) => reason);
		const failure = classifyWorkflowFailure(error);
		assert.equal(failure.disposition, "active_blocked");
		assert.equal(failure.recoverability, "recoverable");
		assert.equal(failure.resumable, true);
		assert.equal(failure.retryable, false);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, STAGE_NAME)[0]?.status, "queued");
	});

	test("recognizes a terminal delivery failure that crossed a realm and lost instanceof", () => {
		assert.equal(isWorkflowPendingStageDeliveryFailure({ code: "pending_stage_delivery_failed" }), true);
		assert.equal(isWorkflowPendingStageDeliveryFailure(new Error("unrelated")), false);
		assert.equal(isWorkflowPendingStageDeliveryFailure(undefined), false);
		assert.equal(isWorkflowPendingStageDeliveryFailure(null), false);
	});
});
