/**
 * Lifecycle notices for the cross-session durable resume path.
 *
 * `/workflow resume <quit-run>` re-dispatches through
 * `resumeDurableWorkflow()`, which reuses the original workflow id so durable
 * checkpoints replay (issue #1498). That re-dispatch calls `recordRunStart`,
 * so without attribution it would announce a brand-new run to the main chat.
 * These tests hold the line that it reports a resume instead, and that the
 * origin recorded on the durable handle survives the resume.
 */

import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	type WorkflowLifecycleNoticeDetails,
	type WorkflowLifecycleNoticeKind,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowActor } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";

interface CapturedNotice {
	readonly content: string;
	readonly details?: WorkflowLifecycleNoticeDetails;
}

type Store = ReturnType<typeof createStore>;

function makeDef(): WorkflowDefinition {
	return workflow({
		name: "resumable-pipeline",
		description: "",
		inputs: { topic: Type.String() },
		outputs: { done: Type.Optional(Type.Boolean()) },
		run: async () => ({ done: true }),
	}) as unknown as WorkflowDefinition;
}

function makeRegistryWith(def: WorkflowDefinition): WorkflowRegistry {
	return {
		register: () => makeRegistryWith(def),
		merge: () => makeRegistryWith(def),
		get: (name: string) => (name === def.name || name === def.normalizedName ? def : undefined),
		has: (name: string) => name === def.name || name === def.normalizedName,
		remove: () => makeRegistryWith(def),
		names: () => [def.normalizedName],
		all: () => [def],
	};
}

function kinds(sent: readonly CapturedNotice[]): (WorkflowLifecycleNoticeKind | undefined)[] {
	return sent.map((notice) => notice.details?.kind);
}

describe("durable resume lifecycle notices", () => {
	let store: Store;
	let backend: InMemoryDurableBackend;
	let cancellation: ReturnType<typeof createCancellationRegistry>;
	let jobs: ReturnType<typeof createJobTracker>;

	beforeEach(() => {
		store = createStore();
		backend = new InMemoryDurableBackend();
		cancellation = createCancellationRegistry();
		jobs = createJobTracker();
	});

	afterEach(() => setDurableBackend(undefined));

	function install(notifyOn: readonly WorkflowLifecycleNoticeKind[]): {
		sent: CapturedNotice[];
		unsubscribe: () => void;
	} {
		const sent: CapturedNotice[] = [];
		const unsubscribe = installWorkflowLifecycleNotifications({
			store,
			state: createWorkflowLifecycleNotificationState(),
			config: { enabled: true, notifyOn },
			sendMessage(message) {
				sent.push(message as CapturedNotice);
			},
		});
		return { sent, unsubscribe };
	}

	function registerQuitWorkflow(workflowId: string, origin?: WorkflowActor): void {
		backend.registerWorkflow({
			workflowId,
			name: "resumable-pipeline",
			inputs: { topic: "data" },
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
			...(origin === undefined ? {} : { origin }),
		});
	}

	function deps(actor?: WorkflowActor) {
		return {
			registry: makeRegistryWith(makeDef()),
			baseRunOpts: {
				store,
				cancellation,
				jobs,
				...(actor === undefined ? {} : { resumeActor: actor }),
			},
			durableBackend: backend,
		};
	}

	test("a user durable resume reports a resume, never a start", async () => {
		const workflowId = testRunId("wf-durable-resumed");
		registerQuitWorkflow(workflowId, "agent");
		const { sent, unsubscribe } = install(["started", "resumed", "completed"]);
		try {
			const result = await resumeDurableWorkflow(workflowId, deps("user"));
			assert.equal(result.ok, true, JSON.stringify(result));

			const control = sent.filter((notice) => notice.details?.kind !== "completed");
			assert.deepEqual(kinds(control), ["resumed"], "re-dispatch must not announce a brand-new run");
			assert.equal(control[0]?.details?.actor, "user");
			// The durable handle recorded who launched the original run, so the
			// resumed run still reads as one the agent started.
			assert.equal(control[0]?.details?.origin, "agent");
			assert.match(control[0]?.content ?? "", /^▶ The user resumed the workflow "resumable-pipeline"/);
			assert.match(control[0]?.content ?? "", /which you started/);
			assert.match(control[0]?.content ?? "", /It is running again in the background\./);
			if (result.ok) {
				// Issue #1498: the re-dispatched run keeps the original workflow id so
				// checkpoints replay and the overlay connects. The notice therefore
				// names one id; a fresh-id continuation names both.
				assert.equal(result.runId, workflowId);
			}
		} finally {
			unsubscribe();
		}
	});

	test("an agent durable resume reports nothing", async () => {
		const workflowId = testRunId("wf-durable-agent");
		registerQuitWorkflow(workflowId, "user");
		const { sent, unsubscribe } = install(["started", "resumed"]);
		try {
			const result = await resumeDurableWorkflow(workflowId, deps("agent"));
			assert.equal(result.ok, true, JSON.stringify(result));
			assert.deepEqual(sent, [], "the workflow tool result already reports the resume it performed");
		} finally {
			unsubscribe();
		}
	});

	test("a durable resume of a run with no recorded origin omits the attribution clause", async () => {
		const workflowId = testRunId("wf-durable-legacy");
		registerQuitWorkflow(workflowId);
		const { sent, unsubscribe } = install(["started", "resumed"]);
		try {
			const result = await resumeDurableWorkflow(workflowId, deps("user"));
			assert.equal(result.ok, true, JSON.stringify(result));
			assert.deepEqual(kinds(sent), ["resumed"]);
			assert.equal(sent[0]?.details?.origin, undefined);
			assert.doesNotMatch(sent[0]?.content ?? "", /which/, "a legacy run's origin is omitted, never guessed");
		} finally {
			unsubscribe();
		}
	});
});
