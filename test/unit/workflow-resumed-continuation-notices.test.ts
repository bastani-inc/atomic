import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, WorkflowActor } from "../../packages/workflows/src/shared/store-types.js";
import { mockSession, Type } from "./executor-shared.js";

interface CapturedNotice {
	readonly content: string;
	readonly details?: WorkflowLifecycleNoticeDetails;
}

type Store = ReturnType<typeof createStore>;

const definition = workflow({
	name: "goal",
	description: "single-stage workflow used to exercise continuation attribution",
	inputs: {},
	outputs: { result: Type.String() },
	run: async (ctx) => {
		const stage = await ctx.task("implement", { prompt: "do the work" });
		return { result: stage.text };
	},
});

function install(store: Store): { sent: CapturedNotice[]; unsubscribe: () => void } {
	const sent: CapturedNotice[] = [];
	const unsubscribe = installWorkflowLifecycleNotifications({
		store,
		state: createWorkflowLifecycleNotificationState(),
		config: { enabled: true, notifyOn: ["started", "resumed", "completed"] },
		sendMessage(message) {
			sent.push(message as CapturedNotice);
		},
	});
	return { sent, unsubscribe };
}

/** A terminal failed run that a continuation can legitimately resume from. */
function failedSourceRun(store: Store, id: string, origin?: WorkflowActor): RunSnapshot {
	store.recordRunStart({
		id,
		name: "goal",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1,
		...(origin === undefined ? {} : { origin }),
	});
	store.recordStageStart(id, { id: "implement", name: "implement", status: "running", parentIds: [], toolEvents: [] });
	store.recordStageEnd(id, {
		id: "implement",
		name: "implement",
		status: "failed",
		parentIds: [],
		toolEvents: [],
		error: "boom",
	});
	store.recordRunEnd(id, "failed", {}, "boom");
	const source = store.runs().find((candidate) => candidate.id === id);
	assert.ok(source);
	return structuredClone(source);
}

async function runContinuation(
	store: Store,
	source: RunSnapshot,
	runId: string,
	resumeActor: WorkflowActor | undefined,
): Promise<void> {
	await run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: new InMemoryDurableBackend(),
			continuation: { source, resumeFromStageId: "implement" },
			...(resumeActor === undefined ? {} : { resumeActor }),
			adapters: {
				agentSession: {
					async create() {
						return mockSession();
					},
				},
			},
		},
	);
}

describe("resumed continuation lifecycle notices", () => {
	test("a user-resumed continuation reports the resume, names both runs, and never reports a start", async () => {
		const store = createStore();
		const source = failedSourceRun(store, "8c31", "agent");
		const { sent, unsubscribe } = install(store);
		try {
			await runContinuation(store, source, "4d7e", "user");

			const resumed = sent.filter((notice) => notice.details?.kind === "resumed");
			assert.equal(resumed.length, 1, "a continuation reports exactly one resume");
			assert.equal(
				sent.some((notice) => notice.details?.kind === "started"),
				false,
				"the user experienced a resume, not a new run",
			);
			assert.equal(resumed[0]?.details?.runId, "4d7e");
			assert.equal(resumed[0]?.details?.continuedFromRunId, "8c31");
			assert.equal(resumed[0]?.details?.origin, "agent", "origin is inherited from the run being continued");
			assert.match(
				resumed[0]?.content ?? "",
				/^▶ The user resumed the workflow "goal" \(run 4d7e, continuing run 8c31\), which you started/,
			);
		} finally {
			unsubscribe();
		}
	});

	test("a continuation inherits origin rather than recomputing it, and stays silent without a requester", async () => {
		const store = createStore();
		const userSource = failedSourceRun(store, "src-user", "user");
		const unattributedSource = failedSourceRun(store, "src-none", undefined);
		const { sent, unsubscribe } = install(store);
		try {
			await runContinuation(store, userSource, "cont-user", "user");
			await runContinuation(store, unattributedSource, "cont-none", "user");
			// An agent-requested continuation of a user-started run: origin and actor
			// disagree, and only the agent-requested one stays out of the chat.
			const agentSource = failedSourceRun(store, "src-agent-req", "user");
			await runContinuation(store, agentSource, "cont-agent-req", "agent");

			// Assert on every kind, not just the resumes: a continuation that reported
			// a spurious `started` alongside them would otherwise pass unnoticed. The
			// source fixtures are ordinary user-started runs and may report their own.
			const startedContinuations = sent.filter(
				(notice) => notice.details?.kind === "started" && notice.details.runId.startsWith("cont-"),
			);
			assert.deepEqual(startedContinuations, [], "a continuation is never a fresh launch, whoever requested it");
			const resumed = sent.filter((notice) => notice.details?.kind === "resumed");
			assert.deepEqual(
				resumed.map((notice) => notice.details?.runId),
				["cont-user", "cont-none"],
				"an agent-requested continuation reports nothing",
			);
			assert.equal(resumed[0]?.details?.origin, "user");
			assert.match(resumed[0]?.content ?? "", /which the user started/);
			assert.equal(resumed[1]?.details?.origin, undefined, "an unrecorded origin is omitted, never guessed");
			assert.doesNotMatch(resumed[1]?.content ?? "", /which/);

			const continuation = store.runs().find((candidate) => candidate.id === "cont-agent-req");
			assert.equal(continuation?.origin, "user", "origin survives the resume without flipping to the requester");
		} finally {
			unsubscribe();
		}
	});
});
