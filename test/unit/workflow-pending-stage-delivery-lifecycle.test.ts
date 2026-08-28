import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager-core.ts";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { resetDbosLifecycleForTests } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import {
	registerPendingStageIntercomBridge,
	settleUndeliverablePendingStageMessages,
} from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	PendingStageMessage,
	PendingStageMessageInput,
	RunStatus,
	StageStatus,
} from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const tempDirs: string[] = [];

function pendingMessage(runId: string, stageKey: string, expectsReply = false): PendingStageMessageInput {
	return {
		runId,
		stageKey,
		from: { id: "planner-session", name: "planner", group: `workflow:${runId}` },
		message: {
			id: `message-${stageKey}`,
			timestamp: 1_725_000_000_000,
			...(expectsReply ? { expectsReply: true } : {}),
			content: { text: "scope changed" },
		},
		queuedAt: "2026-08-26T00:00:00.000Z",
	};
}

async function lifecycleFixture(runStatus: RunStatus, stageStatus: StageStatus = "pending") {
	const activeStore = createStore();
	const backend = new InMemoryDurableBackend();
	const runId = testRunId(`pending-delivery-${runStatus}-${stageStatus}`);
	activeStore.recordRunStart({ id: runId, name: "flow", inputs: {}, status: runStatus, stages: [], startedAt: 1 });
	activeStore.recordStageStart(runId, {
		id: "review-stage",
		name: "reviewer",
		status: stageStatus,
		parentIds: [],
		toolEvents: [],
		...(stageStatus === "skipped" ? { skippedReason: "fail-fast" } : {}),
	});
	backend.registerWorkflow({ workflowId: runId, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	const accepted = await activeStore.queueStageMessage(
		pendingMessage(runId, "review-stage"),
		`workflow:${runId}`,
		`workflow:${runId}`,
		backend,
	);
	assert.equal(accepted?.ok, true);
	return { activeStore, backend, runId };
}

async function renamedLifecycleFixture(runStatus: RunStatus, restoredStageStatus: StageStatus) {
	const runId = testRunId(`pending-delivery-renamed-${runStatus}-${restoredStageStatus}`);
	const group = `workflow:${runId}`;
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: runId, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	const writerStore = createStore();
	writerStore.recordRunStart({ id: runId, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	writerStore.recordStageStart(runId, {
		id: "stable-stage-id",
		name: "old-reviewer-name",
		replayKey: "stage:reviewer:1",
		status: "pending",
		parentIds: [],
		toolEvents: [],
	});
	const queued = await writerStore.queueStageMessage(
		pendingMessage(runId, "old-reviewer-name"),
		group,
		group,
		backend,
	);
	assert.equal(queued?.ok, true);
	const activeStore = createStore();
	activeStore.recordRunStart({
		id: runId,
		name: "flow",
		inputs: {},
		status: runStatus,
		stages: [
			{
				id: "stable-stage-id",
				name: "renamed-reviewer",
				replayKey: "stage:reviewer:1",
				status: restoredStageStatus,
				parentIds: [],
				toolEvents: [],
				...(restoredStageStatus === "skipped" ? { skippedReason: "replayed fail-fast" } : {}),
			},
		],
		startedAt: 1,
		pendingStageMessages: [...(backend.getWorkflow(runId)?.pendingStageMessages ?? [])],
	});
	return { activeStore, backend, runId };
}

afterEach(() => {
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pending workflow stage delivery lifecycle", () => {
	test("registers against an empty store without touching an uninitialized durable backend", async () => {
		const activeStore = createStore();
		setDurableBackend(undefined);
		resetDbosLifecycleForTests();
		const warnings: unknown[][] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args);
		try {
			const dispose = registerPendingStageIntercomBridge({}, activeStore);
			await new Promise((resolve) => setImmediate(resolve));
			dispose();
			assert.deepEqual(warnings, []);
		} finally {
			console.warn = originalWarn;
		}
	});

	test("sweeps eligible durable state added after empty startup exactly once", async () => {
		const activeStore = createStore();
		setDurableBackend(undefined);
		resetDbosLifecycleForTests();
		let notifications = 0;
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit(event, payload) {
						if (event !== "atomic:workflow-pending-stage-undeliverable") return;
						notifications += 1;
						payload.handled = true;
						payload.completion = Promise.resolve(true);
					},
				},
			},
			activeStore,
		);
		await new Promise((resolve) => setImmediate(resolve));

		const backend = new InMemoryDurableBackend();
		const runId = testRunId("pending-delivery-after-empty-startup");
		backend.registerWorkflow({ workflowId: runId, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		activeStore.recordRunStart({ id: runId, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		activeStore.recordStageStart(runId, {
			id: "review-stage",
			name: "reviewer",
			status: "pending",
			parentIds: [],
			toolEvents: [],
		});
		await activeStore.queueStageMessage(
			pendingMessage(runId, "review-stage"),
			`workflow:${runId}`,
			`workflow:${runId}`,
			backend,
		);
		const notified = Promise.withResolvers<void>();
		const unsubscribe = activeStore.subscribeInvalidation(() => {
			if (activeStore.runs()[0]?.pendingStageMessages?.[0]?.undeliverableNotifiedAt !== undefined) {
				notified.resolve();
			}
		});
		activeStore.recordRunEnd(runId, "completed");
		await notified.promise;
		unsubscribe();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(notifications, 1);
		assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
		assert.equal(typeof activeStore.runs()[0]?.pendingStageMessages?.[0]?.undeliverableNotifiedAt, "string");
		dispose();
	});

	test("reports a durable backend error when eligible settlement work exists", async () => {
		const { activeStore } = await lifecycleFixture("completed");
		setDurableBackend(undefined);
		resetDbosLifecycleForTests();
		const warnings: unknown[][] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args);
		let dispose = (): void => {};
		try {
			dispose = registerPendingStageIntercomBridge({}, activeStore);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(warnings.length, 1);
			assert.equal(warnings[0]?.[0], "atomic-workflows: pending stage delivery sweep failed");
			assert.equal((warnings[0]?.[1] as Error | undefined)?.name, "DbosNotReadyError");
			assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "queued");
		} finally {
			dispose();
			console.warn = originalWarn;
		}
	});

	test("marks a skipped stage message undeliverable and notifies its sender", async () => {
		const { activeStore } = await lifecycleFixture("running", "skipped");
		const notifications: string[] = [];
		assert.equal(
			await settleUndeliverablePendingStageMessages(activeStore, async (entry, reason) => {
				notifications.push(`${entry.from.id}:${entry.message.id}:${reason}`);
				return true;
			}),
			1,
		);
		assert.match(notifications[0] ?? "", /planner-session:message-review-stage:.*skipped.*fail-fast/);
		assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
	});

	test("keeps the stable notification outbox pending until recipient acknowledgement", async () => {
		const { activeStore, backend } = await lifecycleFixture("running", "skipped");
		const attempts: string[] = [];
		const reject = async (_entry: PendingStageMessage, _reason: string, notificationId: string) => {
			attempts.push(notificationId);
			return false;
		};
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, reject), 1);
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, reject), 0);
		const pendingReceipt = activeStore.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(pendingReceipt?.status, "undeliverable");
		assert.equal(pendingReceipt?.undeliverableNotifiedAt, undefined);
		assert.equal(
			backend.getWorkflow(activeStore.runs()[0]!.id)?.pendingStageMessages?.[0]?.undeliverableNotifiedAt,
			undefined,
		);
		assert.equal(attempts.length, 2);
		assert.equal(attempts[0], attempts[1]);

		assert.equal(
			await settleUndeliverablePendingStageMessages(activeStore, async (_entry, _reason, notificationId) => {
				attempts.push(notificationId);
				return true;
			}),
			0,
		);
		const acknowledgedReceipt = activeStore.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(typeof acknowledgedReceipt?.undeliverableNotifiedAt, "string");
		assert.equal(attempts[2], attempts[0]);
		assert.equal(
			backend.getWorkflow(activeStore.runs()[0]!.id)?.pendingStageMessages?.[0]?.undeliverableNotifiedAt,
			acknowledgedReceipt?.undeliverableNotifiedAt,
		);
	});

	test("settles and notifies a terminal nested child through the root durable owner exactly once", async () => {
		const rootRunId = testRunId("pending-delivery-nested-root");
		const childRunId = testRunId("pending-delivery-nested-child");
		const group = `workflow:${rootRunId}`;
		const activeStore = createStore();
		activeStore.recordRunStart({
			id: rootRunId,
			name: "root",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "child-boundary",
					name: "workflow:child",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "workflow:child:1",
					workflowChildRun: { alias: "child", workflow: "child", runId: childRunId },
				},
			],
			startedAt: 1,
		});
		activeStore.recordRunStart({
			id: childRunId,
			name: "child",
			inputs: {},
			status: "completed",
			parentRunId: rootRunId,
			parentStageId: "child-boundary",
			rootRunId,
			stages: [
				{
					id: "child-review-stage",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					replayKey: "stage:reviewer:1",
				},
			],
			startedAt: 2,
		});
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: rootRunId, name: "root", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		const childBackend = new ScopedDurableBackend(backend, {
			rootWorkflowId: rootRunId,
			scopePrefix: "workflow:child:1",
		});
		const input = pendingMessage(childRunId, "child-review-stage");
		assert.equal(
			(await activeStore.queueStageMessage({ ...input, from: { ...input.from, group } }, group, group, childBackend))
				?.ok,
			true,
		);
		const notifications: string[] = [];
		const notify = async (entry: PendingStageMessage, reason: string, notificationId: string) => {
			notifications.push(`${entry.runId}:${notificationId}:${reason}`);
			return true;
		};

		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, notify), 1);
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, notify), 0);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0] ?? "", new RegExp(`^${childRunId}:.*completed`));
		assert.equal(backend.getWorkflow(childRunId), undefined);
		assert.equal(backend.getWorkflow(rootRunId)?.pendingStageMessages?.[0]?.status, "undeliverable");
		assert.equal(typeof backend.getWorkflow(rootRunId)?.pendingStageMessages?.[0]?.undeliverableNotifiedAt, "string");
	});
	test("settles a name-addressed skipped destination by canonical identity after durable reload and rename", async () => {
		const runId = testRunId("pending-delivery-canonical-rename");
		const group = `workflow:${runId}`;
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: runId, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		const writerStore = createStore();
		writerStore.recordRunStart({ id: runId, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		writerStore.recordStageStart(runId, {
			id: "stable-stage-id",
			name: "old-reviewer-name",
			replayKey: "stage:reviewer:1",
			status: "pending",
			parentIds: [],
			toolEvents: [],
		});
		writerStore.recordStageStart(runId, {
			id: "unrelated-stage-id",
			name: "other-reviewer-name",
			replayKey: "stage:other:1",
			status: "pending",
			parentIds: [],
			toolEvents: [],
		});
		const queued = await writerStore.queueStageMessage(
			pendingMessage(runId, "old-reviewer-name"),
			group,
			group,
			backend,
		);
		const unrelated = await writerStore.queueStageMessage(
			pendingMessage(runId, "other-reviewer-name"),
			group,
			group,
			backend,
		);
		assert.equal(queued?.ok, true);
		assert.equal(queued?.ok ? queued.entry.stageId : undefined, "stable-stage-id");
		assert.equal(queued?.ok ? queued.entry.stageReplayKey : undefined, "stage:reviewer:1");
		assert.equal(unrelated?.ok, true);

		const reloadedStore = createStore();
		reloadedStore.recordRunStart({
			id: runId,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "stable-stage-id",
					name: "renamed-reviewer",
					replayKey: "stage:reviewer:1",
					status: "skipped",
					parentIds: [],
					toolEvents: [],
					skippedReason: "replayed fail-fast",
				},
				{
					id: "unrelated-stage-id",
					name: "renamed-other-reviewer",
					replayKey: "stage:other:1",
					status: "running",
					parentIds: [],
					toolEvents: [],
				},
			],
			startedAt: 1,
			pendingStageMessages: [...(backend.getWorkflow(runId)?.pendingStageMessages ?? [])],
		});
		const notifications: string[] = [];
		const notify = async (_entry: PendingStageMessage, reason: string): Promise<boolean> => {
			notifications.push(reason);
			return true;
		};
		assert.equal(await settleUndeliverablePendingStageMessages(reloadedStore, notify), 1);
		assert.equal(await settleUndeliverablePendingStageMessages(reloadedStore, notify), 0);
		assert.deepEqual(notifications, ["Workflow stage old-reviewer-name was skipped (replayed fail-fast)"]);
		const entries = reloadedStore.runs()[0]?.pendingStageMessages ?? [];
		assert.equal(entries.find((entry) => entry.stageId === "stable-stage-id")?.status, "undeliverable");
		assert.equal(entries.find((entry) => entry.stageId === "unrelated-stage-id")?.status, "queued");
	});

	test("uses stable replay identity when a durable entry has no canonical stage id", async () => {
		const { backend, runId } = await renamedLifecycleFixture("running", "skipped");
		const durableEntry = backend.getWorkflow(runId)?.pendingStageMessages?.[0];
		assert.ok(durableEntry !== undefined);
		const { stageId: discardedStageId, ...replayEntry } = durableEntry;
		assert.equal(discardedStageId, "stable-stage-id");
		assert.equal(replayEntry.stageReplayKey, "stage:reviewer:1");
		const replayedStore = createStore();
		replayedStore.recordRunStart({
			id: runId,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "recreated-stage-id",
					name: "renamed-reviewer",
					replayKey: "stage:reviewer:1",
					status: "skipped",
					parentIds: [],
					toolEvents: [],
					skippedReason: "replayed by stable key",
				},
			],
			startedAt: 1,
			pendingStageMessages: [replayEntry],
		});
		const notifications: string[] = [];
		assert.equal(
			await settleUndeliverablePendingStageMessages(replayedStore, async (_entry, reason) => {
				notifications.push(reason);
				return true;
			}),
			1,
		);
		assert.deepEqual(notifications, ["Workflow stage old-reviewer-name was skipped (replayed by stable key)"]);
		assert.equal(replayedStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
	});

	test("retains exact legacy id and unique-name fallback without collapsing duplicate names", async () => {
		const { backend, runId } = await renamedLifecycleFixture("running", "skipped");
		const durableEntry = backend.getWorkflow(runId)?.pendingStageMessages?.[0];
		assert.ok(durableEntry !== undefined);
		const { stageId: discardedStageId, stageReplayKey: discardedReplayKey, ...legacyBase } = durableEntry;
		assert.equal(discardedStageId, "stable-stage-id");
		assert.equal(discardedReplayKey, "stage:reviewer:1");
		const legacyEntry = (stageKey: string, id: string): PendingStageMessage => ({
			...legacyBase,
			id,
			stageKey,
			message: { ...legacyBase.message, id },
		});
		const legacyById = legacyEntry("legacy-stage-id", "legacy-id-message");
		const legacyByName = legacyEntry("legacy-reviewer", "legacy-name-message");
		const ambiguousLegacy = legacyEntry("duplicate-reviewer", "ambiguous-name-message");
		const unknownCanonical: PendingStageMessage = {
			...legacyEntry("legacy-reviewer", "unknown-canonical-message"),
			stageId: "missing-canonical-stage",
		};
		const activeStore = createStore();
		activeStore.recordRunStart({
			id: runId,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "legacy-stage-id",
					name: "renamed-legacy-id",
					status: "skipped",
					parentIds: [],
					toolEvents: [],
					skippedReason: "legacy id",
				},
				{
					id: "legacy-name-stage-id",
					name: "legacy-reviewer",
					status: "skipped",
					parentIds: [],
					toolEvents: [],
					skippedReason: "legacy name",
				},
				{
					id: "duplicate-a",
					name: "duplicate-reviewer",
					status: "skipped",
					parentIds: [],
					toolEvents: [],
				},
				{
					id: "duplicate-b",
					name: "duplicate-reviewer",
					status: "running",
					parentIds: [],
					toolEvents: [],
				},
			],
			startedAt: 1,
			pendingStageMessages: [legacyById, legacyByName, ambiguousLegacy, unknownCanonical],
		});
		const notifications: string[] = [];
		const notify = async (entry: PendingStageMessage, reason: string): Promise<boolean> => {
			notifications.push(`${entry.id}:${reason}`);
			return true;
		};
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, notify), 2);
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, notify), 0);
		assert.deepEqual(notifications, [
			"legacy-id-message:Workflow stage legacy-stage-id was skipped (legacy id)",
			"legacy-name-message:Workflow stage legacy-reviewer was skipped (legacy name)",
		]);
		const statuses = Object.fromEntries(
			(activeStore.runs()[0]?.pendingStageMessages ?? []).map((entry) => [entry.id, entry.status]),
		);
		assert.deepEqual(statuses, {
			"legacy-id-message": "undeliverable",
			"legacy-name-message": "undeliverable",
			"ambiguous-name-message": "queued",
			"unknown-canonical-message": "queued",
		});
	});

	test("settles a name-addressed cancelled destination after durable reload and rename", async () => {
		const { activeStore } = await renamedLifecycleFixture("cancelled", "skipped");
		const reasons: string[] = [];
		const notify = async (_entry: PendingStageMessage, reason: string): Promise<boolean> => {
			reasons.push(reason);
			return true;
		};
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, notify), 1);
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, notify), 0);
		assert.deepEqual(reasons, [
			`Workflow run ${activeStore.runs()[0]?.id} terminated with status cancelled before stage old-reviewer-name started`,
		]);
		assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
	});

	test("settles a name-addressed terminal-before-init destination after durable reload and rename", async () => {
		const { activeStore } = await renamedLifecycleFixture("completed", "pending");
		const reasons: string[] = [];
		const notify = async (_entry: PendingStageMessage, reason: string): Promise<boolean> => {
			reasons.push(reason);
			return true;
		};
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, notify), 1);
		assert.equal(await settleUndeliverablePendingStageMessages(activeStore, notify), 0);
		assert.deepEqual(reasons, [
			`Workflow run ${activeStore.runs()[0]?.id} terminated with status completed before stage old-reviewer-name started`,
		]);
		assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
	});

	test("leaves blocked and nonterminal stage routing untouched", async () => {
		for (const status of ["blocked", "running", "completed"] as const) {
			const { activeStore } = await lifecycleFixture("running", status);
			assert.equal(await settleUndeliverablePendingStageMessages(activeStore, async () => true), 0);
			assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "queued");
		}
	});
});

test("a crash after sender-visible failure notification reloads to exactly one notification and terminal state", async () => {
	const runId = testRunId("pending-delivery-notification-crash");
	const group = `workflow:${runId}`;
	const persistedSdk = createMockSdk();
	let failNextMetadataWrite = false;
	const sdk = {
		...persistedSdk,
		async recordStepOutput(...args: Parameters<typeof persistedSdk.recordStepOutput>) {
			if (failNextMetadataWrite) {
				failNextMetadataWrite = false;
				throw new Error("simulated process exit after notification");
			}
			await persistedSdk.recordStepOutput(...args);
		},
	};
	const writer = new DbosDurableBackend(sdk, { executorId: "notification-writer" });
	writer.registerWorkflow({ workflowId: runId, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const activeStore = createStore();
	activeStore.recordRunStart({ id: runId, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	activeStore.recordStageStart(runId, {
		id: "review-stage",
		name: "reviewer",
		status: "skipped",
		parentIds: [],
		toolEvents: [],
		skippedReason: "fail-fast",
	});
	await activeStore.queueStageMessage(pendingMessage(runId, "review-stage"), group, group, writer);

	const workflowSocket = {} as net.Socket;
	const senderSocket = {} as net.Socket;
	const sessionInfo = (id: string, name: string): SessionInfo => ({
		id,
		name,
		group,
		cwd: "/repo",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	});
	const sessions = new Map<string, BrokerConnectedSession>([
		["workflow-owner", { socket: workflowSocket, info: sessionInfo("workflow-owner", "workflow-owner") }],
		["planner-session", { socket: senderSocket, info: sessionInfo("planner-session", "planner") }],
	]);
	const recipientSessionDir = mkdtempSync(join(tmpdir(), "pending-failure-recipient-"));
	tempDirs.push(recipientSessionDir);
	let recipientSession = SessionManager.create("/repo", recipientSessionDir);
	let recipientAdmission = new InboundMessageAdmission();
	let deliveredMessages = new DeliveredMessageCache();
	let senderVisibleNotifications = 0;
	let wireNotifications = 0;
	const notifyThroughBroker = async (
		entry: PendingStageMessage,
		reason: string,
		notificationId: string,
	): Promise<boolean> => {
		const actionable = `Pending workflow stage could not receive intercom message: ${reason}`;
		const message: Message = {
			id: notificationId,
			timestamp: Date.now(),
			replyTo: entry.message.id,
			replyError: actionable,
			content: { text: actionable },
		};
		const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
		const recipientCompletions: Promise<void>[] = [];
		handleBrokerSend(
			workflowSocket,
			{ type: "send", to: entry.from.id, message },
			"workflow-owner",
			sessions,
			deliveredMessages,
			(socket, brokerMessage) => {
				writes.push({ socket, message: brokerMessage });
				if (socket !== senderSocket || brokerMessage.type !== "message") return;
				wireNotifications++;
				const admission = recipientAdmission.admit(brokerMessage.from, brokerMessage.message);
				if (admission.kind === "pending") {
					recipientCompletions.push(admission.completion);
					return;
				}
				if (admission.kind === "duplicate") return;
				recipientCompletions.push(
					Promise.resolve().then(() => {
						senderVisibleNotifications++;
						recipientSession.appendCustomMessageEntry(
							"intercom_message",
							brokerMessage.message.content.text,
							true,
							{ from: brokerMessage.from, message: brokerMessage.message },
							undefined,
							undefined,
							`intercom:${brokerMessage.message.id}`,
						);
						recipientSession.flush();
						recipientAdmission.commit(admission.reservation);
					}),
				);
			},
		);
		await Promise.all(recipientCompletions);
		return writes.some(
			(write) =>
				write.socket === workflowSocket &&
				write.message.type === "delivered" &&
				write.message.messageId === notificationId,
		);
	};

	await assert.rejects(
		settleUndeliverablePendingStageMessages(activeStore, async (entry, reason, notificationId) => {
			const delivered = await notifyThroughBroker(entry, reason, notificationId);
			failNextMetadataWrite = true;
			return delivered;
		}),
		/simulated process exit after notification/,
	);
	assert.equal(senderVisibleNotifications, 1);
	assert.equal(wireNotifications, 1);

	const reader = new DbosDurableBackend(sdk, { executorId: "notification-reader" });
	await reader.hydrateWorkflow(runId);
	const pendingNotification = reader.getWorkflow(runId)?.pendingStageMessages?.[0];
	assert.equal(pendingNotification?.status, "undeliverable");
	assert.equal(
		typeof (pendingNotification as { undeliverableNotificationId?: string })?.undeliverableNotificationId,
		"string",
	);
	assert.equal((pendingNotification as { undeliverableNotifiedAt?: string })?.undeliverableNotifiedAt, undefined);
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: runId,
		name: "flow",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "review-stage",
				name: "reviewer",
				status: "skipped",
				parentIds: [],
				toolEvents: [],
				skippedReason: "fail-fast",
			},
		],
		startedAt: 1,
		pendingStageMessages: [...(reader.getWorkflow(runId)?.pendingStageMessages ?? [])],
	});
	setDurableBackend(reader);
	// Simulate broker and sender-stage process restarts from their durable records.
	deliveredMessages = new DeliveredMessageCache();
	const recipientSessionFile = recipientSession.getSessionFile();
	assert.ok(recipientSessionFile !== undefined);
	recipientSession = SessionManager.open(recipientSessionFile, recipientSessionDir, "/repo");
	recipientAdmission = new InboundMessageAdmission();
	recipientAdmission.restore(recipientSession.getBranch());
	assert.equal(await settleUndeliverablePendingStageMessages(reloadedStore, notifyThroughBroker), 0);
	assert.equal(wireNotifications, 2);
	assert.equal(senderVisibleNotifications, 1);
	const terminal = new DbosDurableBackend(sdk, { executorId: "notification-terminal-reader" });
	await terminal.hydrateWorkflow(runId);
	const terminalEntry = terminal.getWorkflow(runId)?.pendingStageMessages?.[0];
	assert.equal(terminalEntry?.status, "undeliverable");
	assert.equal(typeof (terminalEntry as { undeliverableNotifiedAt?: string })?.undeliverableNotifiedAt, "string");
});
