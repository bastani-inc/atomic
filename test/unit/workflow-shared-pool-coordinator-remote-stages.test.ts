import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { durableBackendForRun } from "../../packages/workflows/src/durable/run-owner-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { EMPTY_STAGE_QUEUED_USER_MESSAGES } from "../../packages/workflows/src/runs/foreground/stage-queued-user-messages.js";
import { externalRunRouteOwner } from "../../packages/workflows/src/shared/external-run-routes.js";
import { workflowInvocationIntercomGroup } from "../../packages/workflows/src/shared/intercom-group.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import {
	isRemoteStageCommandUnsupportedError,
	RemoteStageCommandUnsupportedError,
	StageInputRefusedError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import type { DeliveryOpId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	type Fixture,
	fanOut,
	fixture,
	STUB_QUESTION,
	satellite,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

useTemporaryAgentDir();

/**
 * The root's side of stages that run on another host's worker (#4391): chat text, question reads and answers, and
 * Intercom messages go through each stage's input queue in the shared journal, and survive the stage's host stopping.
 */

/** How long a test watches a host take again an input its stage keeps giving back (#4391). */
const RETRY_WINDOW_MS = 4_000;
/** How long the root waits for the receipt of an input in a test whose stage never takes it (#4391). */
const UNTAKEN_INPUT_TIMEOUT_MS = 4_000;

/** Waits for `check` to hold, failing with `what` once the run ended first. */
async function until(
	what: string,
	check: () => boolean | Promise<boolean>,
	execution: Promise<unknown>,
): Promise<void> {
	let ended = false;
	void execution.finally(() => {
		ended = true;
	});
	while (!(await check())) {
		assert.equal(ended, false, `the run ended before ${what}`);
		await sleep(25);
	}
}

/** The stub worker's log lines of the stage inputs it applied, in order. */
function appliedInputs(log: string): string[] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => /^(answer|question|user|intercom) /.test(line));
}

/** Queues an Intercom message for `stageKey` of `runId` in the root's store, as the root's bridge does. */
async function queueIntercom(f: Fixture, store: Store, runId: string, stageKey: string, id: string): Promise<void> {
	const group = workflowInvocationIntercomGroup("root");
	const result = await store.queueStageMessage(
		{
			runId,
			stageKey,
			from: { id: "planner", name: "planner", group },
			message: { id, timestamp: 1_725_000_000_000, content: { text: `body ${id}` } },
			queuedAt: new Date().toISOString(),
		},
		group,
		group,
		durableBackendForRun(f.backend, store, runId)!,
	);
	assert.equal(result?.ok, true, JSON.stringify(result));
}

test(
	"the root reaches a stage on another host: its chat steers, its question is shown and answered, its Intercom message arrives, each once through the stage's input queue (#4391)",
	async () => {
		const registry = createStageControlRegistry();
		const f = await fixture("shared-coordinator-remote-stage", {
			workspace: binding,
			stageControlRegistry: registry,
		});
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_LIVE_STAGE", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const store = createStore();
		const broker = new StageUiBroker(store);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store, durableBackend: f.backend, stageUiBroker: broker },
		);
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => f.directory });
			let runId = "";
			await until(
				"host B's stage to reach the root",
				() => {
					runId =
						store.runs().find((candidate) => candidate.stages.some((entry) => entry.id === "stage"))?.id ?? "";
					return registry.get(runId, "stage") !== undefined;
				},
				execution,
			);
			const handle = registry.get(runId, "stage");
			assert.ok(handle?.sendUserMessage !== undefined);
			// The chat's steer and follow-up are admitted on host B, through the stage's input queue.
			assert.equal(await handle.sendUserMessage("steer from root", { deliverAs: "steer" }), "steer");
			assert.equal(await handle.sendUserMessage("then this", { deliverAs: "followUp" }), "followUp");
			// Only a stage on the root's host pauses or runs session commands; one on another host says so, typed.
			const paused = await handle.pause().catch((error: Error) => error);
			assert.ok(isRemoteStageCommandUnsupportedError(paused), String(paused));
			assert.ok(paused instanceof RemoteStageCommandUnsupportedError);
			assert.deepEqual(
				[paused.code, paused.command, paused.runId, paused.stageId],
				["remote-stage-command-unsupported", "pause", runId, "stage"],
			);
			const watch = await f.pool.watchPooledStage({ runId, stageId: "stage" }, () => {});
			assert.ok(watch.ok);
			assert.deepEqual(
				watch.watch.snapshot,
				{
					sessionId: "session-stage",
					status: "running",
					isStreaming: false,
					messages: [],
					pendingToolExecutionEvents: [],
					queued: EMPTY_STAGE_QUEUED_USER_MESSAGES,
					deliveredOps: [],
					turnStarted: true,
					sessionStarted: true,
					seq: 0,
				},
				"a view of a stage on another host shows its status and session, and no transcript; its text goes out at once",
			);
			const session = await f.pool
				.sessionCommandOnPooledStage(watch.watch.id, { kind: "compact" })
				.catch((error: Error) => error);
			assert.ok(isRemoteStageCommandUnsupportedError(session) && session.command === "session");
			await f.pool.unwatchPooledStage(watch.watch.id);
			// The stage's ask_user_question form is read from host B and shown in the root's broker; its answer goes back.
			await until(
				"the stage's question to be shown",
				() => broker.peekStageQuestionnaire(runId, "stage") !== undefined,
				execution,
			);
			assert.deepEqual(broker.peekStageQuestionnaire(runId, "stage")?.params, STUB_QUESTION.params);
			assert.equal(broker.answerStagePrompt(runId, "stage", { optionLabels: ["yes"] }), true);
			// The root's pool owns the run's route and says which stages another host runs.
			const owner = externalRunRouteOwner(store, runId);
			// The root run's own stage, the child's boundary, runs on no worker.
			const boundary = store.run("root")!.stages[0]!.id;
			assert.deepEqual(
				[
					owner?.deliversQueued(runId, "stage"),
					owner?.deliversQueued(runId, "missing"),
					owner?.deliversQueued("unknown-run", "stage"),
					owner?.deliversQueued("root", boundary),
				],
				[true, false, false, false],
			);
			// An Intercom message queued for the stage reaches its session on host B, and is recorded delivered.
			await queueIntercom(f, store, runId, "stage", "intercom-1");
			await until(
				"the Intercom message to be delivered",
				() => store.pendingStageMessagesFor(runId, "stage").length === 0,
				execution,
			);
			await until(
				"the answer to reach host B",
				() => appliedInputs(f.log).some((line) => line.startsWith("answer ")),
				execution,
			);
			const applied = appliedInputs(f.log);
			assert.deepEqual(
				applied.filter((line) => line.startsWith("user ")).map((line) => line.split(" ").slice(2).join(" ")),
				["steer steer from root", "followUp then this"],
				"the chat's text arrived once each, in send order",
			);
			assert.deepEqual(applied.filter((line) => !line.startsWith("user ")).sort(), [
				`answer ${runId} stage q1`,
				"intercom session-stage intercom-1",
				`question ${runId} stage`,
			]);
			assert.ok(readFileSync(f.log, "utf8").includes("received session-stage intercom-1\n"));
			const inputs = await f.shared.stageInputs("root", runId, "stage");
			assert.deepEqual(
				inputs.map((input) => input.kind).sort(),
				["intercom-message", "prompt-answer", "question-read", "user-message", "user-message"],
				"each delivery was queued once",
			);
			assert.ok(inputs.every((input) => input.state === "done"));
			// Each input's op names its delivery and the attempt it was queued for.
			assert.deepEqual(
				inputs
					.filter((input) => input.kind !== "prompt-answer")
					.map((input) => input.op.replace(/^(user):[^:]+:/, "$1:<op>:"))
					.sort(),
				["intercom:session-stage:intercom-1:1", "question:q1:1", "user:<op>:1", "user:<op>:1"],
			);
			// Text the stage's session fails to admit fails typed, not as unconfirmed text to send again.
			const view = await f.pool.watchPooledStage({ runId, stageId: "stage" }, () => {});
			assert.ok(view.ok);
			const failed = await f.pool
				.deliverToPooledStage({
					watch: view.watch.id,
					op: "error-busy" as DeliveryOpId,
					text: "x",
					intent: "steer",
				})
				.catch((error: Error) => error);
			assert.ok(failed instanceof StageInputRefusedError && failed.reason === "stage-failed", String(failed));
			// A message the stage session fails to take is settled undeliverable, for its sender to be told, and the
			// stage's later messages and text are not held behind it.
			await queueIntercom(f, store, runId, "stage", "error-broken");
			await queueIntercom(f, store, runId, "stage", "intercom-after");
			await until(
				"the message after the failed one to be delivered",
				() => store.pendingStageMessagesFor(runId, "stage").length === 0,
				execution,
			);
			const settled = store.run(runId)?.pendingStageMessages ?? [];
			assert.deepEqual(
				["error-broken", "intercom-after"].map((id) => settled.find((entry) => entry.message.id === id)?.status),
				["undeliverable", "delivered"],
			);
			assert.equal(
				settled.find((entry) => entry.message.id === "error-broken")?.undeliverableReason,
				"The stage's session failed to take it: broken",
			);
			assert.deepEqual(
				readFileSync(f.log, "utf8")
					.split("\n")
					.filter((line) => line.startsWith("received session-stage intercom-after")),
				["received session-stage intercom-after"],
				"the later message reached the session once",
			);
			assert.equal(store.run("root")?.intercomDeliveryIssue, undefined, "no drain is left failing");
			assert.equal(
				await handle.sendUserMessage("after the failure", { deliverAs: "followUp", expandPromptTemplates: false }),
				"followUp",
			);
			assert.match(
				readFileSync(f.log, "utf8"),
				/^user \S+ followUp after the failure expand=false$/m,
				"the later text reached host B, with its own options",
			);
			// A stage that no other host runs opens no view of another host.
			for (const ref of [
				{ runId, stageId: "missing" },
				{ runId: "unknown-run", stageId: "stage" },
				{ runId: "root", stageId: "stage" },
				{ runId: "root", stageId: store.run("root")!.stages[0]!.id },
			])
				assert.deepEqual(await f.pool.watchPooledStage(ref, () => {}), { ok: false, refusal: "StageNotOnWorker" });
			writeFileSync(release, "");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"inputs queued for a stage whose host stopped are taken by the host that takes the stage over, each applied once (#4391)",
	async () => {
		const f = await fixture("shared-coordinator-remote-failover", { workspace: binding });
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_LIVE_STAGE", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const store = createStore();
		const hosts: PoolCoordinator[] = [];
		const execution = run(parent, {}, { runId: "root", cwd: f.directory, store, durableBackend: f.backend });
		try {
			const root = await f.root();
			const warmHere = { prefer: async () => f.directory };
			const first = await satellite(f, root, warmHere, [], "host-b");
			hosts.push(first);
			let runId = "";
			await until(
				"host B's stage to reach the root",
				() => {
					const stage = store.runs().find((candidate) => candidate.stages.some((entry) => entry.id === "stage"));
					runId = stage?.id ?? "";
					return stage?.stages.find((entry) => entry.id === "stage")?.sessionId === "session-stage";
				},
				execution,
			);
			const ended: unknown[] = [];
			const watch = await f.pool.watchPooledStage({ runId, stageId: "stage" }, (message) => {
				if (message.kind === "ended") ended.push(message.reason);
			});
			assert.ok(watch.ok);
			// Host B stops: its child goes back to the queue, and the root's text waits in the stage's input queue.
			await first.stopSatellite();
			const delivery = f.pool.deliverToPooledStage({
				watch: watch.watch.id,
				op: "op-failover" as DeliveryOpId,
				text: "after failover",
				intent: "followUp",
			});
			await until(
				"the text to be queued",
				async () => (await f.shared.stageInputs("root", runId, "stage")).length === 1,
				execution,
			);
			assert.deepEqual(
				appliedInputs(f.log).filter((line) => line.startsWith("user ")),
				[],
				"no host took it yet",
			);
			// Host C takes the stage over: it takes the input host B never took, and the Intercom message queued meanwhile.
			await queueIntercom(f, store, runId, "stage", "intercom-failover");
			hosts.push(await satellite(f, root, warmHere, [], "host-c"));
			assert.deepEqual(await delivery, { ok: true, action: "followUp" });
			await until(
				"the Intercom message to be delivered on host C",
				() => store.pendingStageMessagesFor(runId, "stage").length === 0,
				execution,
			);
			// A drain of the replaced attempt that the root had not yet seen replaced may hand the message over under its
			// own op as well: the stage session takes it once.
			assert.deepEqual(
				readFileSync(f.log, "utf8")
					.split("\n")
					.filter((line) => /^(user|received) /.test(line)),
				["user op-failover followUp after failover", "received session-stage intercom-failover"],
				"each input reached the stage once, on the host that took the stage over",
			);
			assert.deepEqual(
				f.claims().map(([claimer]) => claimer),
				["host-b", "host-c"],
			);
			// Host C's activity ended the view of host B's attempt: text sent through it now is refused as stale.
			await until("the view to end", () => ended.length > 0, execution);
			assert.deepEqual(ended, ["attempt_fenced"]);
			assert.deepEqual(
				await f.pool.deliverToPooledStage({
					watch: watch.watch.id,
					op: "op-after-fence" as DeliveryOpId,
					text: "to the fenced view",
					intent: "followUp",
				}),
				{ ok: false, refusal: "StaleAttempt" },
			);
			writeFileSync(release, "");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
		} finally {
			for (const host of hosts) {
				await host.stopSatellite();
				await host.shutdown();
			}
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"an Intercom message a stopped host took and gave back is refused as replaced on the host that takes the stage over, reaches the new session once, and later text follows (#4391)",
	async () => {
		const f = await fixture("shared-coordinator-remote-replaced-session", { workspace: binding });
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_LIVE_STAGE", "1");
		// Each host's stage runs its own session, and host B's never takes an Intercom message.
		vi.stubEnv("SHARED_POOL_STUB_SESSION_PER_HOST", "1");
		vi.stubEnv("SHARED_POOL_STUB_INTERCOM_PENDING_HOST", "host-b");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const store = createStore();
		const hosts: PoolCoordinator[] = [];
		const execution = run(parent, {}, { runId: "root", cwd: f.directory, store, durableBackend: f.backend });
		const sessionOf = (runId: string) => store.run(runId)?.stages.find((entry) => entry.id === "stage")?.sessionId;
		try {
			const root = await f.root();
			const warmHere = { prefer: async () => f.directory };
			hosts.push(await satellite(f, root, warmHere, [], "host-b"));
			let runId = "";
			await until(
				"host B's stage to reach the root",
				() => {
					runId =
						store.runs().find((candidate) => candidate.stages.some((entry) => entry.id === "stage"))?.id ?? "";
					return sessionOf(runId) === "session-host-b";
				},
				execution,
			);
			await queueIntercom(f, store, runId, "stage", "intercom-replaced");
			await until(
				"host B to take the message and give it back",
				() => readFileSync(f.log, "utf8").includes("intercom session-host-b intercom-replaced\n"),
				execution,
			);
			// Host B takes it again only after a wait that doubles each time its stage gives it back: 0, 0.5, 1.5 and
			// 3.5 s into this window, where a take on every 0.5 s pass would be 8. A slower host takes it fewer times.
			await sleep(RETRY_WINDOW_MS);
			const takes = readFileSync(f.log, "utf8")
				.split("\n")
				.filter((line) => line === "intercom session-host-b intercom-replaced").length;
			assert.ok(takes >= 2 && takes <= 5, `host B took the message ${takes} times in ${RETRY_WINDOW_MS} ms`);
			await hosts[0]!.stopSatellite();
			hosts.push(await satellite(f, root, warmHere, [], "host-c"));
			await until(
				"the Intercom message to be delivered on host C",
				() => store.pendingStageMessagesFor(runId, "stage").length === 0,
				execution,
			);
			assert.deepEqual(
				readFileSync(f.log, "utf8")
					.split("\n")
					.filter((line) => line.startsWith("received ")),
				["received session-host-c intercom-replaced"],
				"the message reached the session that replaced host B's, once",
			);
			const inputs = await f.shared.stageInputs("root", runId, "stage");
			assert.deepEqual(
				inputs
					.filter((input) => input.kind === "intercom-message")
					.map((input) => [input.op, input.state, input.receipt]),
				[
					[
						"intercom:session-host-b:intercom-replaced:1",
						"done",
						JSON.stringify({ ok: false, refusal: "SessionReplaced" }),
					],
					["intercom:session-host-c:intercom-replaced:2", "done", JSON.stringify({ ok: true })],
				],
				"host C settled host B's input as replaced instead of retrying it, and took the new session's",
			);
			// Nothing is stuck at the head of the stage's queue: chat text sent now reaches host C's stage.
			await until("host C's stage to reach the root", () => sessionOf(runId) === "session-host-c", execution);
			const watch = await f.pool.watchPooledStage({ runId, stageId: "stage" }, () => {});
			assert.ok(watch.ok);
			assert.deepEqual(watch.watch.attempt.generation, 2);
			assert.deepEqual(
				await f.pool.deliverToPooledStage({
					watch: watch.watch.id,
					op: "op-after-failover" as DeliveryOpId,
					text: "later text",
					intent: "followUp",
				}),
				{ ok: true, action: "followUp" },
			);
			assert.ok(readFileSync(f.log, "utf8").includes("user op-after-failover followUp later text\n"));
			const issue = store.run("root")?.intercomDeliveryIssue;
			assert.equal(issue, undefined, "a drain into the replaced session is not reported as a delivery issue");
			writeFileSync(release, "");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
		} finally {
			for (const host of hosts) {
				await host.stopSatellite();
				await host.shutdown();
			}
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a view of a stage on another host ends as fenced once a worker on the root's host takes the stage's work over (#4391)",
	async () => {
		const f = await fixture("shared-coordinator-remote-taken-over", {});
		const release = join(f.directory, "release");
		const gate = join(f.directory, "claim-gate");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_LIVE_STAGE", "1");
		// The root's own worker claims nothing until the gate opens, so host B takes the child first.
		vi.stubEnv("SHARED_POOL_STUB_CLAIM_GATE_HOST", "root-host");
		vi.stubEnv("SHARED_POOL_STUB_CLAIM_GATE", gate);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const store = createStore();
		let host: PoolCoordinator | undefined;
		const execution = run(parent, {}, { runId: "root", cwd: f.directory, store, durableBackend: f.backend });
		try {
			const root = await f.root();
			host = await satellite(f, root, {}, [], "host-b", 1);
			let runId = "";
			await until(
				"host B's stage to reach the root",
				() => {
					const owner = store.runs().find((candidate) => candidate.stages.some((entry) => entry.id === "stage"));
					runId = owner?.id ?? "";
					return owner?.stages.find((entry) => entry.id === "stage")?.sessionId === "session-stage";
				},
				execution,
			);
			const ended: unknown[] = [];
			const watch = await f.pool.watchPooledStage({ runId, stageId: "stage" }, (message) => {
				if (message.kind === "ended") ended.push(message.reason);
			});
			assert.ok(watch.ok);
			assert.equal(watch.watch.attempt.generation, 1);
			await host.stopSatellite();
			writeFileSync(gate, "");
			await until(
				"the root's own worker to take the child over",
				async () => (await f.shared.stats("root")).leases.some((lease) => lease.host === "root-host"),
				execution,
			);
			// The view was of host B's attempt: it ended as fenced, so text sent to it is refused as stale rather than
			// queued for the attempt that replaced it.
			await until("the view to end", () => ended.length > 0, execution);
			assert.deepEqual(ended, ["attempt_fenced"]);
			assert.deepEqual(
				await f.pool.deliverToPooledStage({
					watch: watch.watch.id,
					op: "op-stale-view" as DeliveryOpId,
					text: "to the old view",
					intent: "followUp",
				}),
				{ ok: false, refusal: "StaleAttempt" },
			);
			assert.deepEqual(
				(await f.shared.stageInputs("root", runId, "stage")).filter((input) => input.kind === "user-message"),
				[],
				"no text was queued",
			);
			writeFileSync(release, "");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
		} finally {
			writeFileSync(release, "");
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"text a stage on another host never takes reads as unconfirmed, an Intercom message it never takes is reported on the root, and text for a child that ended is refused (#4391)",
	async () => {
		const f = await fixture("shared-coordinator-remote-untaken", {
			workspace: binding,
			stageInputTimeoutMs: UNTAKEN_INPUT_TIMEOUT_MS,
		});
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_LIVE_STAGE", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const store = createStore();
		let host: PoolCoordinator | undefined;
		const execution = run(parent, {}, { runId: "root", cwd: f.directory, store, durableBackend: f.backend });
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => f.directory });
			let runId = "";
			await until(
				"host B's stage to reach the root",
				() => {
					runId =
						store.runs().find((candidate) => candidate.stages.some((entry) => entry.id === "stage"))?.id ?? "";
					return store.run(runId)?.stages.find((entry) => entry.id === "stage")?.sessionId === "session-stage";
				},
				execution,
			);
			const watch = await f.pool.watchPooledStage({ runId, stageId: "stage" }, () => {});
			assert.ok(watch.ok);
			// The stub's stage gives back text and messages whose id is "refuse-StaleAttempt" every time it takes them.
			const deliver = (op: string) =>
				f.pool.deliverToPooledStage({
					watch: watch.watch.id,
					op: op as DeliveryOpId,
					text: op,
					intent: "followUp",
				});
			assert.deepEqual(await deliver("refuse-StaleAttempt"), { ok: false, refusal: "Unconfirmed" });
			await queueIntercom(f, store, runId, "stage", "refuse-StaleAttempt");
			await until(
				"the root to report the message it could not deliver",
				() => /\(stage-input-timeout\)/.test(store.run("root")?.intercomDeliveryIssue ?? ""),
				execution,
			);
			assert.match(
				store.run("root")?.intercomDeliveryIssue ?? "",
				/the host running the stage has not had the stage take it/,
				"host B runs the stage and keeps giving the message back: it is deferred, not unclaimed",
			);
			assert.deepEqual(
				store.pendingStageMessagesFor(runId, "stage").map((entry) => entry.message.id),
				["refuse-StaleAttempt"],
				"the message stays queued",
			);
			const pending = deliver("refuse-StaleAttempt-after");
			writeFileSync(release, "");
			assert.deepEqual(await pending, { ok: false, refusal: "StageNotLive" }, "the child ended while it waited");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
		} finally {
			writeFileSync(release, "");
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a view of a stage on another host ends once that host publishes the stage finished, and text sent to it then is refused as not live (#4391)",
	async () => {
		const f = await fixture("shared-coordinator-remote-finished", { workspace: binding });
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_LIVE_STAGE", "1");
		vi.stubEnv("SHARED_POOL_STUB_FINISH_STAGE", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const store = createStore();
		let host: PoolCoordinator | undefined;
		const execution = run(parent, {}, { runId: "root", cwd: f.directory, store, durableBackend: f.backend });
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => f.directory });
			let runId = "";
			await until(
				"host B's stage to reach the root",
				() => {
					runId =
						store.runs().find((candidate) => candidate.stages.some((entry) => entry.id === "stage"))?.id ?? "";
					return store.run(runId)?.stages.find((entry) => entry.id === "stage")?.sessionId === "session-stage";
				},
				execution,
			);
			const ended: unknown[] = [];
			const watch = await f.pool.watchPooledStage({ runId, stageId: "stage" }, (message) => {
				if (message.kind === "ended") ended.push(message.reason);
			});
			assert.ok(watch.ok);
			writeFileSync(release, "");
			await until("the view to end", () => ended.length > 0, execution);
			assert.deepEqual(ended, ["stage_finished"]);
			assert.deepEqual(
				await f.pool.deliverToPooledStage({
					watch: watch.watch.id,
					op: "op-after-finish" as DeliveryOpId,
					text: "too late",
					intent: "followUp",
				}),
				{ ok: false, refusal: "StageNotLive" },
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
		} finally {
			writeFileSync(release, "");
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
