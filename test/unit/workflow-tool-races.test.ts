import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { killRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { sleep } from "../helpers/runtime.js";

function installFailureNotices(store: ReturnType<typeof createStore>): {
	readonly notices: WorkflowLifecycleNoticeDetails[];
	readonly unsubscribe: () => void;
} {
	const notices: WorkflowLifecycleNoticeDetails[] = [];
	const unsubscribe = installWorkflowLifecycleNotifications({
		store,
		config: { enabled: true, notifyOn: ["failed"] },
		state: createWorkflowLifecycleNotificationState(),
		seedExisting: false,
		sendMessage(message) {
			notices.push((message as { details: WorkflowLifecycleNoticeDetails }).details);
		},
	});
	return { notices, unsubscribe };
}

function waitForToolStatus(
	store: ReturnType<typeof createStore>,
	runId: string,
	toolName: string,
	status: "failed" | "cancelled",
): Promise<void> {
	const matches = (): boolean =>
		store
			.runs()
			.find((run) => run.id === runId)
			?.toolNodes?.some((node) => node.name === toolName && node.status === status) === true;
	if (matches()) return Promise.resolve();
	return new Promise((resolve) => {
		const unsubscribe = store.subscribe(() => {
			if (!matches()) return;
			unsubscribe();
			resolve();
		});
	});
}
describe("ctx.tool persistence and cancellation races", () => {
	test("cancellation during retry backoff leaves a cancelled node and no checkpoint", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const controller = new AbortController();
		const attempted = Promise.withResolvers<void>();
		let attempts = 0;
		const pending = run(
			workflow({
				name: "cancel retry backoff",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool(
						"retrying-write",
						{},
						async () => {
							attempts += 1;
							attempted.resolve();
							throw new Error("transient write failure");
						},
						{ retriesAllowed: true, maxAttempts: 3, intervalMs: 10_000 },
					);
					return {};
				},
			}),
			{},
			{ store, durableBackend: backend, signal: controller.signal },
		);

		await attempted.promise;
		await Promise.resolve();
		controller.abort(new Error("operator cancelled during backoff"));
		const result = await pending;

		assert.equal(result.status, "killed");
		assert.equal(attempts, 1);
		assert.equal(result.toolNodes?.[0]?.status, "cancelled");
		assert.equal(
			backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.kind === "tool"),
			false,
		);
	});

	test("failure observed before a late cancellation wins while catch drains another tool", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const cancellation = createCancellationRegistry();
		const lifecycle = installFailureNotices(store);
		const blockerEntered = Promise.withResolvers<void>();
		const blockerRelease = Promise.withResolvers<void>();
		const failureEntered = Promise.withResolvers<void>();
		const failureRelease = Promise.withResolvers<void>();
		const runId = "failure-first-catch-drain";
		const pending = run(
			workflow({
				name: "failure first catch drain",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					void ctx.tool("drain-blocker", {}, async () => {
						blockerEntered.resolve();
						await blockerRelease.promise;
						return "released";
					});
					await ctx.tool("callback-first", {}, async () => {
						failureEntered.resolve();
						await failureRelease.promise;
						throw new Error("callback failed before cancellation");
					});
					return {};
				},
			}),
			{},
			{ runId, store, durableBackend: backend, cancellation },
		);

		await Promise.all([blockerEntered.promise, failureEntered.promise]);
		failureRelease.resolve();
		await waitForToolStatus(store, runId, "callback-first", "failed");
		assert.equal(killRun(runId, { store, cancellation }).ok, true);
		blockerRelease.resolve();
		const result = await pending;
		lifecycle.unsubscribe();

		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(result.status, "failed");
		assert.equal(snapshot?.failureKind, "unknown");
		assert.equal(snapshot?.failureDisposition, "terminal_failed");
		assert.match(result.error ?? "", /callback failed before cancellation/);
		assert.equal(result.toolNodes?.find((node) => node.name === "callback-first")?.status, "failed");
		assert.equal(result.toolNodes?.find((node) => node.name === "drain-blocker")?.status, "cancelled");
		assert.equal(lifecycle.notices.length, 1);
		assert.equal(lifecycle.notices[0]?.kind, "failed");
	});

	test("unawaited failure during normal drain terminates a non-cooperative sibling", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const lifecycle = installFailureNotices(store);
		const persisted: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const persistence = {
			appendEntry(type: string, payload: Record<string, unknown>): string {
				persisted.push({ type, payload });
				return `entry-${persisted.length}`;
			},
			setLabel(_entryId: string, _label: string): void {},
		};
		const failureEntered = Promise.withResolvers<void>();
		const failureRelease = Promise.withResolvers<void>();
		const blockerEntered = Promise.withResolvers<void>();
		const blockerRelease = Promise.withResolvers<void>();
		const runId = "failure-first-normal-drain";
		const pending = run(
			workflow({
				name: "failure first normal drain",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					void ctx.tool("normal-drain-blocker", {}, async () => {
						blockerEntered.resolve();
						await blockerRelease.promise;
						return "released";
					});
					void ctx.tool("unawaited-second", {}, async () => {
						failureEntered.resolve();
						await failureRelease.promise;
						throw new Error("second-admitted failure won");
					});
					return {};
				},
			}),
			{},
			{ runId, store, durableBackend: backend, persistence },
		);

		await Promise.all([failureEntered.promise, blockerEntered.promise]);
		failureRelease.resolve();
		const result = await Promise.race([pending, sleep(250).then(() => undefined)]);
		assert.ok(result, "failure observed during drain must settle without an external cancellation");

		assert.equal(result.status, "failed");
		assert.equal(result.error, "second-admitted failure won");
		const failedNode = result.toolNodes?.find((node) => node.name === "unawaited-second");
		assert.equal(result.failedToolNodeId, failedNode?.id);
		assert.equal(failedNode?.status, "failed");
		assert.equal(result.toolNodes?.find((node) => node.name === "normal-drain-blocker")?.status, "cancelled");
		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(snapshot?.error, "second-admitted failure won");
		assert.equal(snapshot?.failedToolNodeId, failedNode?.id);
		const runEnds = persisted.filter((entry) => entry.type === "workflow.run.end");
		assert.equal(runEnds.length, 1);
		assert.equal(runEnds[0]?.payload.status, "failed");
		assert.equal(runEnds[0]?.payload.failedToolNodeId, failedNode?.id);
		assert.equal((runEnds[0]?.payload.failedToolNode as { status?: string } | undefined)?.status, "failed");
		assert.equal(lifecycle.notices.length, 1);
		assert.equal(lifecycle.notices[0]?.toolName, "unawaited-second");
		assert.equal(lifecycle.notices[0]?.error, "second-admitted failure won");

		blockerRelease.resolve();
		await sleep(0);
		lifecycle.unsubscribe();
		assert.equal(
			backend
				.listCheckpoints(runId)
				.some((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "normal-drain-blocker"),
			false,
		);
	});

	test("ordinary failure settles despite a non-cooperative sibling tool", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const lifecycle = installFailureNotices(store);
		const blockerEntered = Promise.withResolvers<void>();
		const blockerRelease = Promise.withResolvers<void>();
		const failureEntered = Promise.withResolvers<void>();
		const releaseFailure = Promise.withResolvers<void>();
		const runId = "failure-with-non-cooperative-sibling";
		const pending = run(
			workflow({
				name: "failure with non cooperative sibling",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					void ctx.tool("non-cooperative", {}, async () => {
						blockerEntered.resolve();
						await blockerRelease.promise;
						return "late success";
					});
					await ctx.tool("failure-winner", {}, async () => {
						failureEntered.resolve();
						await releaseFailure.promise;
						throw new Error("winner failed without kill");
					});
					return {};
				},
			}),
			{},
			{ runId, store, durableBackend: backend },
		);

		await Promise.all([blockerEntered.promise, failureEntered.promise]);
		releaseFailure.resolve();
		const result = await Promise.race([pending, sleep(250).then(() => undefined)]);

		assert.ok(result, "ordinary failure must not wait forever for a callback that ignores cancellation");
		assert.equal(result.status, "failed");
		assert.equal(result.error, "winner failed without kill");
		const winner = result.toolNodes?.find((node) => node.name === "failure-winner");
		assert.equal(result.failedToolNodeId, winner?.id);
		assert.equal(result.toolNodes?.find((node) => node.name === "non-cooperative")?.status, "cancelled");
		assert.equal(lifecycle.notices.length, 1);
		assert.equal(lifecycle.notices[0]?.toolName, "failure-winner");

		blockerRelease.resolve();
		await sleep(0);
		lifecycle.unsubscribe();
		assert.equal(result.toolNodes?.find((node) => node.name === "non-cooperative")?.status, "cancelled");
		assert.equal(
			backend
				.listCheckpoints(runId)
				.some((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "non-cooperative"),
			false,
			"a late sibling callback must not create a successful checkpoint",
		);
		assert.equal(lifecycle.notices.length, 1);
	});

	test("preserves first terminal tool attribution when concurrent failures throw the same value", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const lifecycle = installFailureNotices(store);
		const sharedError = new Error("shared concurrent failure");
		const firstEntered = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const runId = "same-value-failure-attribution";
		const pending = run(
			workflow({
				name: "same value failure attribution",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const first = ctx.tool("first-admitted", {}, async () => {
						firstEntered.resolve();
						await releaseFirst.promise;
						throw sharedError;
					});
					const second = ctx.tool("first-terminal", {}, async () => {
						secondEntered.resolve();
						await releaseSecond.promise;
						throw sharedError;
					});
					await Promise.all([first, second]);
					return {};
				},
			}),
			{},
			{ runId, store, durableBackend: backend },
		);

		await Promise.all([firstEntered.promise, secondEntered.promise]);
		releaseSecond.resolve();
		await waitForToolStatus(store, runId, "first-terminal", "failed");
		releaseFirst.resolve();
		const result = await pending;
		lifecycle.unsubscribe();

		const winningNode = result.toolNodes?.find((node) => node.name === "first-terminal");
		assert.equal(result.status, "failed");
		assert.equal(result.failedToolNodeId, winningNode?.id);
		assert.equal(lifecycle.notices.length, 1);
		assert.equal(lifecycle.notices[0]?.toolName, "first-terminal");
		assert.equal(lifecycle.notices[0]?.error, "shared concurrent failure");
	});

	test("cancellation observed before callback failure wins and emits no failed notice", async () => {
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		const cancellation = createCancellationRegistry();
		const lifecycle = installFailureNotices(store);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runId = "cancellation-first";
		const pending = run(
			workflow({
				name: "cancellation first",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("cancelled-before-throw", {}, async () => {
						entered.resolve();
						await release.promise;
						throw new Error("late callback failure");
					});
					return {};
				},
			}),
			{},
			{ runId, store, durableBackend: backend, cancellation },
		);

		await entered.promise;
		assert.equal(killRun(runId, { store, cancellation }).ok, true);
		release.resolve();
		const result = await pending;
		lifecycle.unsubscribe();

		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(result.status, "killed");
		assert.equal(snapshot?.failureKind, "cancelled");
		assert.equal(snapshot?.failureDisposition, "terminal_killed");
		assert.equal(result.toolNodes?.[0]?.status, "cancelled");
		assert.equal(lifecycle.notices.length, 0);
	});

	test("writer rejection after callback success fails node and root without a completed checkpoint", async () => {
		class RejectingBackend extends InMemoryDurableBackend {
			override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
				if (checkpoint.kind === "tool") throw new Error("durable writer rejected");
				await super.recordCheckpointAsync(checkpoint);
			}
		}
		const store = createStore();
		const backend = new RejectingBackend();
		let callbackCalls = 0;
		const result = await run(
			workflow({
				name: "writer rejects",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("committed-side-effect", {}, async () => {
						callbackCalls += 1;
						return "external success";
					});
					return {};
				},
			}),
			{},
			{ store, durableBackend: backend },
		);

		assert.equal(callbackCalls, 1);
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /durable writer rejected/);
		assert.equal(result.toolNodes?.[0]?.status, "failed");
		assert.equal(
			backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.kind === "tool"),
			false,
		);
	});

	test("checkpoint commit wins an in-flight cancellation but the root never claims completion", async () => {
		class GatedBackend extends InMemoryDurableBackend {
			readonly writeStarted = Promise.withResolvers<void>();
			readonly releaseWrite = Promise.withResolvers<void>();
			override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
				if (checkpoint.kind === "tool") {
					this.writeStarted.resolve();
					await this.releaseWrite.promise;
				}
				await super.recordCheckpointAsync(checkpoint);
			}
		}
		const store = createStore();
		const backend = new GatedBackend();
		const controller = new AbortController();
		const pending = run(
			workflow({
				name: "cancel during commit",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("commit-linearization", {}, async () => "ready-to-commit");
					return {};
				},
			}),
			{},
			{ store, durableBackend: backend, signal: controller.signal },
		);

		await backend.writeStarted.promise;
		controller.abort(new Error("cancelled while durable write was in flight"));
		backend.releaseWrite.resolve();
		const result = await pending;

		assert.equal(result.status, "killed", "root cancellation remains authoritative");
		assert.equal(result.toolNodes?.[0]?.status, "completed", "successful durable commit is not rolled back");
		assert.equal(backend.listCheckpoints(result.runId).filter((checkpoint) => checkpoint.kind === "tool").length, 1);
	});

	test("return-mode cancellation during failure commit throws before downstream code", async () => {
		class GatedFailureBackend extends InMemoryDurableBackend {
			readonly writeStarted = Promise.withResolvers<void>();
			readonly releaseWrite = Promise.withResolvers<void>();
			override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
				if (checkpoint.kind === "tool") {
					this.writeStarted.resolve();
					await this.releaseWrite.promise;
				}
				await super.recordCheckpointAsync(checkpoint);
			}
		}
		const backend = new GatedFailureBackend();
		const controller = new AbortController();
		let downstreamRan = false;
		let observedOutcome = false;
		const pending = run(
			workflow({
				name: "cancel during recoverable failure commit",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const outcome = await ctx.tool(
						"failed-check",
						{},
						async () => {
							throw new Error("expected check failure");
						},
						{ failureMode: "return" },
					);
					observedOutcome = outcome.ok === false;
					downstreamRan = true;
					return {};
				},
			}),
			{},
			{ store: createStore(), durableBackend: backend, signal: controller.signal },
		);

		await backend.writeStarted.promise;
		controller.abort(new Error("cancelled while failure checkpoint was in flight"));
		backend.releaseWrite.resolve();
		const result = await pending;

		assert.equal(result.status, "killed");
		assert.equal(observedOutcome, false);
		assert.equal(downstreamRan, false);
		assert.equal(result.toolNodes?.[0]?.status, "failed");
		assert.equal(backend.listCheckpoints(result.runId).filter((checkpoint) => checkpoint.kind === "tool").length, 1);
	});

	test("tool-node terminal updates are idempotent", () => {
		const store = createStore();
		store.recordRunStart({
			id: "terminal-idempotence",
			name: "terminal",
			inputs: {},
			status: "running",
			stages: [],
			toolNodes: [],
			startedAt: 1,
		});
		store.recordToolNodeStart("terminal-idempotence", {
			kind: "tool",
			id: "tool:terminal",
			name: "terminal",
			argsHash: "hash",
			ordinal: 1,
			parentIds: [],
			status: "pending",
			attachable: false,
		});
		store.recordToolNodeRunning("terminal-idempotence", "tool:terminal", 2);

		assert.equal(
			store.recordToolNodeEnd("terminal-idempotence", "tool:terminal", {
				status: "completed",
				endedAt: 3,
				resultSummary: "first",
			}),
			true,
		);
		assert.equal(
			store.recordToolNodeEnd("terminal-idempotence", "tool:terminal", {
				status: "failed",
				endedAt: 4,
				error: "late",
			}),
			false,
		);
		assert.deepEqual(store.runs()[0]?.toolNodes?.[0], {
			kind: "tool",
			id: "tool:terminal",
			name: "terminal",
			argsHash: "hash",
			ordinal: 1,
			parentIds: [],
			status: "completed",
			attachable: false,
			startedAt: 2,
			endedAt: 3,
			resultSummary: "first",
			executionOrder: 1,
		});
	});

	test("terminal runs refuse new tool nodes but accept admitted terminal updates", () => {
		const store = createStore();
		store.recordRunStart({
			id: "terminal-store-guard",
			name: "terminal",
			inputs: {},
			status: "running",
			stages: [],
			toolNodes: [],
			startedAt: 1,
		});
		assert.equal(
			store.recordToolNodeStart("terminal-store-guard", {
				kind: "tool",
				id: "tool:admitted",
				name: "admitted",
				argsHash: "admitted",
				ordinal: 1,
				parentIds: [],
				status: "pending",
				attachable: false,
			}),
			true,
		);
		assert.equal(store.recordRunEnd("terminal-store-guard", "completed", {}, undefined), true);
		assert.equal(
			store.recordToolNodeStart("terminal-store-guard", {
				kind: "tool",
				id: "tool:late",
				name: "late",
				argsHash: "late",
				ordinal: 2,
				parentIds: [],
				status: "pending",
				attachable: false,
			}),
			false,
		);
		assert.equal(store.recordToolNodeRunning("terminal-store-guard", "tool:admitted", 2), true);
		assert.equal(
			store.recordToolNodeEnd("terminal-store-guard", "tool:admitted", {
				status: "completed",
				endedAt: 3,
				resultSummary: "settled",
			}),
			true,
		);
		assert.deepEqual(
			store.runs()[0]?.toolNodes?.map((node) => [node.id, node.status]),
			[["tool:admitted", "completed"]],
		);
	});
});
