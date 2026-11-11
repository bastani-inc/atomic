import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "unreachable-recipients-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { isSubagentRecipientEndedError, isSubagentRecipientDisconnectedError, isIntercomRecipientGoneError } =
	await import("../../packages/intercom/broker/recipient-gone-errors.js");

type Client = InstanceType<typeof IntercomClient>;
type SendResult = Awaited<ReturnType<Client["send"]>>;
type PendingStageMessageRequest = import("../../packages/intercom/broker/client.js").PendingStageMessageRequest;

/** A real broker process: these tests cross its socket, its disconnect handling and its registration. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
/** Long enough for a frame another socket wrote to reach the broker and be applied. */
const SETTLE_MS = 300;

let broker: ChildProcess | undefined;

async function connect(
	name: string,
	options: {
		ownerToken?: string;
		supervisor?: { capability: string; supervisorSessionId: string };
		returnAddress?: string;
		/** The Intercom id a reopened session asks to keep, as a workflow stage's does. */
		preferredSessionId?: string | null;
		group?: string;
	} = {},
): Promise<Client> {
	const client = new IntercomClient(
		options.returnAddress ?? randomUUID(),
		options.preferredSessionId ? { preferredSessionId: options.preferredSessionId } : undefined,
	);
	client.on("error", () => {});
	const group = options.group ?? "default";
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group,
			groups: [group],
		},
		options.supervisor,
		options.ownerToken,
		undefined,
		group,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

async function untilGone(observer: Client, sessionId: string | null): Promise<void> {
	assert.ok(sessionId);
	await vi.waitFor(
		async () =>
			assert.equal(
				(await observer.listSessions()).some((session) => session.id === sessionId),
				false,
			),
		{ timeout: 10_000, interval: 20 },
	);
}

/** Start a send and report its result once it settles, without awaiting it. */
function track(sending: Promise<SendResult>): {
	readonly settled: () => SendResult | undefined;
	readonly done: Promise<SendResult>;
} {
	let result: SendResult | undefined;
	const done = sending.then((value) => {
		result = value;
		return value;
	});
	return { settled: () => result, done };
}

beforeAll(async () => {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	await vi.waitFor(
		async () => {
			brokerFixture.assertRunning();
			const connected = await new Promise<boolean>((resolveConnected) => {
				const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
				socket.once("connect", () => {
					socket.destroy();
					resolveConnected(true);
				});
				socket.once("error", () => resolveConnected(false));
			});
			assert.ok(connected);
		},
		{ timeout: 10_000, interval: 20 },
	);
});
afterAll(() => brokerFixture.cleanup());

test(
	"a send to a subagent whose session just ended waits for its owner's verdict, then names that it completed and the resume call (#4639)",
	async () => {
		const owner = await connect("ended-owner", { ownerToken: randomUUID() });
		const childName = "subagent-worker-aabcf28b-1";
		const childSessionId = randomUUID();
		const child = await connect(childName, {
			supervisor: await owner.authorizeSupervisorChild(childName),
			returnAddress: childSessionId,
		});
		const childIntercomId = child.sessionId;
		await child.disconnect();
		await untilGone(owner, childIntercomId);

		const sender = await connect("ended-sender");
		const held = track(sender.send(childName, { text: "are you done?" }));
		await vi.waitFor(
			async () => {
				assert.equal(held.settled()?.reason, undefined, "the send waits for the owner instead of failing");
				assert.equal((await owner.brokerStatus())?.heldSends, 1);
			},
			{ timeout: 10_000, interval: 20 },
		);

		await owner.markEndedChildren([
			{ childName, childId: "aabcf28b:0", outcome: "completed", aliases: [childSessionId] },
		]);
		const refused = await held.done;
		assert.equal(refused.delivered, false);
		assert.ok(refused.error !== undefined && isSubagentRecipientEndedError(refused.error), refused.reason);
		assert.equal(refused.error.code, "recipient_completed");
		assert.equal(refused.reasonCode, "recipient_completed");
		assert.deepEqual(
			{ target: refused.error.target, childName: refused.error.childName, childId: refused.error.childId },
			{ target: childName, childName, childId: "aabcf28b:0" },
		);
		assert.equal(refused.error.retryable, false);
		assert.equal(
			refused.reason,
			'Subagent "subagent-worker-aabcf28b-1" completed and has no live session (recipient_completed). Its launching session can continue it with subagent({ action: "resume", id: "aabcf28b:0", message: "<your message>" }).',
		);

		for (const target of [childName, childSessionId, childIntercomId!]) {
			const later = await sender.send(target, { text: "still there?" });
			assert.ok(later.error !== undefined && isSubagentRecipientEndedError(later.error), later.reason);
			assert.equal(later.error.code, "recipient_completed");
			assert.equal(later.error.target, target);
		}
		assert.equal((await owner.brokerStatus())?.heldSends, 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a send to a subagent whose connection dropped is held and delivered once when it reconnects (#4639)",
	async () => {
		const owner = await connect("reconnect-owner", { ownerToken: randomUUID() });
		const childName = "subagent-worker-reconnect-1";
		const child = await connect(childName, { supervisor: await owner.authorizeSupervisorChild(childName) });
		const firstId = child.sessionId;
		await child.disconnect();
		await untilGone(owner, firstId);

		const sender = await connect("reconnect-sender");
		const held = track(sender.send(childName, { text: "after the blip" }));
		await vi.waitFor(async () => assert.equal((await owner.brokerStatus())?.heldSends, 1), {
			timeout: 10_000,
			interval: 20,
		});
		assert.equal(held.settled(), undefined);

		const received: string[] = [];
		const back = new IntercomClient(randomUUID());
		back.on("error", () => {});
		back.on("message", (_from: object, message: { content: { text: string } }) =>
			received.push(message.content.text),
		);
		brokerFixture.onCleanup(() => back.disconnect().catch(() => undefined));
		await back.connect(
			{
				name: childName,
				model: "test-model",
				cwd: repoRoot,
				pid: process.pid,
				status: "idle",
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group: "default",
				groups: ["default"],
			},
			await owner.authorizeSupervisorChild(childName),
			undefined,
			undefined,
			"default",
		);
		const delivered = await held.done;
		assert.equal(delivered.delivered, true, delivered.reason);
		await vi.waitFor(() => assert.deepEqual(received, ["after the blip"]), { timeout: 10_000, interval: 20 });
		await sleep(SETTLE_MS);
		assert.deepEqual(received, ["after the blip"]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a subagent its owner reports ended before anyone sends is refused at once, by why it ended (#4639)",
	async () => {
		const owner = await connect("verdict-owner", { ownerToken: randomUUID() });
		const sender = await connect("verdict-sender");
		await owner.markEndedChildren([
			{ childName: "subagent-worker-killed-1", childId: "k1:0", outcome: "cancelled", aliases: [] },
			{ childName: "subagent-worker-failed-1", childId: "f1:0", outcome: "failed", aliases: [] },
			{ childName: "subagent-worker-quit-1", childId: "q1:0", outcome: "stopped", aliases: [] },
		]);
		const codes: string[] = [];
		for (const target of ["subagent-worker-killed-1", "subagent-worker-failed-1", "subagent-worker-quit-1"]) {
			const refused = await sender.send(target, { text: "hello" });
			assert.ok(refused.error !== undefined && isIntercomRecipientGoneError(refused.error), refused.reason);
			assert.equal(isSubagentRecipientDisconnectedError(refused.error), false);
			codes.push(refused.error.code);
		}
		assert.deepEqual(codes, ["recipient_cancelled", "recipient_failed", "recipient_stopped"]);

		const outsider = await connect("verdict-outsider", { group: "elsewhere" });
		const hidden = await outsider.send("subagent-worker-killed-1", { text: "hello" });
		assert.equal(hidden.reason, "Session not found", "a sender outside the subagent's group learns nothing");
		assert.equal(hidden.error, undefined);

		const childName = "subagent-worker-killed-1";
		const resumed = await connect(childName, { supervisor: await owner.authorizeSupervisorChild(childName) });
		const received: string[] = [];
		resumed.on("message", (_from: object, message: { content: { text: string } }) =>
			received.push(message.content.text),
		);
		const delivered = await sender.send(childName, { text: "welcome back" });
		assert.equal(delivered.delivered, true, delivered.reason);
		const resumedId = resumed.sessionId;
		await resumed.disconnect();
		await untilGone(owner, resumedId);
		const afterResume = track(sender.send(childName, { text: "and now?" }));
		await vi.waitFor(async () => assert.equal((await owner.brokerStatus())?.heldSends, 1), {
			timeout: 10_000,
			interval: 20,
		});
		assert.equal(afterResume.settled(), undefined, "a resumed child's old verdict no longer answers for it");
		await owner.disconnect();
		const ownerGone = await afterResume.done;
		assert.equal(ownerGone.delivered, false);
		assert.ok(
			ownerGone.error !== undefined && isSubagentRecipientDisconnectedError(ownerGone.error),
			ownerGone.reason,
		);
		assert.equal(ownerGone.error.retryable, true, "with its owner away nobody says why: the sender may try again");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"what a launching session reported about its subagents outlives its connection, as a suspended stage's does (#4639)",
	async () => {
		const hostSession = randomUUID();
		const owner = await connect("away-owner", { ownerToken: randomUUID(), returnAddress: hostSession });
		const sender = await connect("away-sender");
		await owner.markEndedChildren([
			{ childName: "subagent-worker-away-1", childId: "a1:0", outcome: "completed", aliases: [] },
		]);
		const ownerIntercomId = owner.sessionId;
		await owner.disconnect();
		await untilGone(sender, ownerIntercomId);

		const refused = await sender.send("subagent-worker-away-1", { text: "are you there?" });
		assert.ok(refused.error !== undefined && isSubagentRecipientEndedError(refused.error), refused.reason);
		assert.equal(refused.error.code, "recipient_completed");
		assert.equal(refused.error.childId, "a1:0");

		const outsider = await connect("away-outsider", { group: "elsewhere" });
		const hidden = await outsider.send("subagent-worker-away-1", { text: "hello" });
		assert.equal(hidden.reason, "Session not found", "a sender outside the subagent's group learns nothing");

		const back = await connect("away-owner", { ownerToken: randomUUID(), returnAddress: hostSession });
		await back.markEndedChildren([
			{ childName: "subagent-worker-away-1", childId: "a1:0", outcome: "failed", aliases: [] },
		]);
		const afterBack = await sender.send("subagent-worker-away-1", { text: "and now?" });
		assert.ok(afterBack.error !== undefined && isSubagentRecipientEndedError(afterBack.error), afterBack.reason);
		assert.equal(afterBack.error.code, "recipient_failed", "the returning session's report replaces the kept one");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a subagent that drops after its launching session left is held, and answered when that session is back (#4639)",
	async () => {
		const hostSession = randomUUID();
		const childName = "subagent-worker-late-1";
		const owner = await connect("late-owner", { ownerToken: randomUUID(), returnAddress: hostSession });
		const sender = await connect("late-sender");
		const child = await connect(childName, { supervisor: await owner.authorizeSupervisorChild(childName) });
		const ownerIntercomId = owner.sessionId;
		const childIntercomId = child.sessionId;
		await owner.disconnect();
		await untilGone(sender, ownerIntercomId);
		await child.disconnect();
		await untilGone(sender, childIntercomId);

		const held = track(sender.send(childName, { text: "where did you go?" }));
		await vi.waitFor(
			async () => {
				assert.equal(held.settled(), undefined, "the send waits for a verdict");
				assert.equal((await sender.brokerStatus())?.heldSends, 1);
			},
			{ timeout: 10_000, interval: 20 },
		);

		const back = await connect("late-owner", {
			ownerToken: randomUUID(),
			returnAddress: hostSession,
			preferredSessionId: ownerIntercomId ?? undefined,
		});
		await back.markEndedChildren([{ childName, childId: "l1:0", outcome: "completed", aliases: [] }]);
		const answered = await held.done;
		assert.equal(answered.delivered, false);
		assert.ok(answered.error !== undefined && isSubagentRecipientEndedError(answered.error), answered.reason);
		assert.equal(answered.error.code, "recipient_completed");
		assert.equal((await sender.brokerStatus())?.heldSends, 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a released subagent of a launching session whose connection closed, as a suspended stage's does, keeps its sends held until that session is back and wakes it (#4639)",
	async () => {
		const ownerSessionId = randomUUID();
		const childName = "subagent-worker-suspended-1";
		const owner = await connect("suspended-stage", { ownerToken: randomUUID(), returnAddress: ownerSessionId });
		await owner.reserveReleasedChildren([{ childName, wake: true }]);
		const ownerIntercomId = owner.sessionId;
		await owner.disconnect();
		const sender = await connect("suspended-sender");
		await untilGone(sender, ownerIntercomId);

		const held = track(sender.send(childName, { text: "while your stage is suspended" }));
		await vi.waitFor(
			async () => {
				assert.equal(held.settled()?.reason, undefined, "the send waits for the launching session to come back");
				assert.equal((await sender.brokerStatus())?.heldSends, 1);
			},
			{ timeout: 10_000, interval: 20 },
		);

		const back = await connect("suspended-stage", { ownerToken: randomUUID(), returnAddress: ownerSessionId });
		const wakes: string[] = [];
		back.on("restoring_recipient_wake", (notice: { childName: string }) => wakes.push(notice.childName));
		await back.reserveReleasedChildren([{ childName, wake: true }]);
		await vi.waitFor(() => assert.deepEqual(wakes, [childName]), { timeout: 10_000, interval: 20 });
		await back.acknowledgeReleasedChildWake(childName);

		const child = new IntercomClient(randomUUID());
		child.on("error", () => {});
		const received: string[] = [];
		child.on("message", (_from: object, message: { content: { text: string } }) =>
			received.push(message.content.text),
		);
		brokerFixture.onCleanup(() => child.disconnect().catch(() => undefined));
		await child.connect(
			{
				name: childName,
				model: "test-model",
				cwd: repoRoot,
				pid: process.pid,
				status: "idle",
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group: "default",
				groups: ["default"],
			},
			await back.authorizeSupervisorChild(childName),
			undefined,
			undefined,
			"default",
		);
		const delivered = await held.done;
		assert.equal(delivered.delivered, true, delivered.reason);
		await vi.waitFor(() => assert.deepEqual(received, ["while your stage is suspended"]), {
			timeout: 10_000,
			interval: 20,
		});

		const other = await connect("suspended-other", { ownerToken: randomUUID(), returnAddress: randomUUID() });
		await other.reserveReleasedChildren([{ childName: "subagent-worker-suspended-2", wake: true }]);
		const otherId = other.sessionId;
		await other.disconnect();
		await untilGone(sender, otherId);
		const stranger = await connect("suspended-stranger", { ownerToken: randomUUID() });
		await assert.rejects(
			stranger.reserveReleasedChildren([{ childName: "subagent-worker-suspended-2", wake: true }]),
			(error: Error & { readonly code?: string }) => error.code === "not_owner",
			"another session cannot take a suspended session's released subagent",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

const STAGE_RUN_ID = "46390000-3528-413e-84c4-87a43e5037a2";
const STAGE_GROUP = `workflow:${STAGE_RUN_ID}`;
const ROUTE_CAPABILITY = "issue-4639-route-capability";
const LAUNCHER_CAPABILITY = "issue-4639-launcher-capability";
const STAGE_TARGET = `workflow:${STAGE_RUN_ID}/orchestrator-id`;

interface StageRoute {
	readonly owner: Client;
	readonly launcher: Client;
	readonly requests: PendingStageMessageRequest[];
}

async function stageRoute(): Promise<StageRoute> {
	const owner = await connect("issue-4639-route-owner", { group: STAGE_GROUP });
	const requests: PendingStageMessageRequest[] = [];
	owner.on("pending_stage_message", (request: PendingStageMessageRequest) => {
		requests.push(request);
		owner.respondPendingStageMessage(
			request.requestId,
			request.live === true ? { outcome: "forward", target: STAGE_TARGET } : { outcome: "queued", position: 1 },
		);
	});
	await owner.registerPendingStageRouteAcknowledged(
		STAGE_RUN_ID,
		STAGE_GROUP,
		ROUTE_CAPABILITY,
		[
			{
				stageId: "orchestrator-id",
				stageName: "orchestrator",
				target: STAGE_TARGET,
				lifecycle: "running",
				routeEligible: true,
				group: STAGE_GROUP,
			},
		],
		undefined,
		undefined,
		undefined,
		LAUNCHER_CAPABILITY,
	);
	const launcher = await connect("issue-4639-launcher");
	assert.equal(await launcher.claimWorkflowInvocation(STAGE_RUN_ID, LAUNCHER_CAPABILITY), true);
	return { owner, launcher, requests };
}

async function stageSession(
	atomicSessionId: string,
): Promise<{ readonly client: Client; readonly received: string[] }> {
	const client = await connect(`subagent-chat-${atomicSessionId}`, {
		group: STAGE_GROUP,
		returnAddress: atomicSessionId,
	});
	const received: string[] = [];
	client.on("message", (_from: object, message: { content: { text: string } }) => received.push(message.content.text));
	client.registerPendingStageRoute(STAGE_RUN_ID, STAGE_GROUP, ROUTE_CAPABILITY);
	await client.registerLiveWorkflowStageRoute(STAGE_RUN_ID, ["orchestrator-id", "orchestrator"], ROUTE_CAPABILITY);
	return { client, received };
}

test(
	"the session that launched a run reaches its live stage at the stage session's name, and at that name again after the stage's session is replaced or suspended (#4639)",
	async () => {
		const { owner, launcher, requests } = await stageRoute();
		const firstSessionId = randomUUID();
		const first = await stageSession(firstSessionId);
		const firstName = `subagent-chat-${firstSessionId}`;

		const live = await launcher.send(firstName, { text: "status?" });
		assert.equal(live.delivered, true, live.reason);
		await vi.waitFor(() => assert.deepEqual(first.received, ["status?"]), { timeout: 10_000, interval: 20 });

		const firstIntercomId = first.client.sessionId;
		await first.client.disconnect();
		await untilGone(owner, firstIntercomId);
		const suspended = await launcher.send(firstName, { text: "while you wait" });
		assert.equal(suspended.delivered, false);
		assert.equal(suspended.queued, true, suspended.reason);
		assert.equal(suspended.target, STAGE_TARGET);
		assert.equal(requests.at(-1)?.live, undefined, "queued for the stage, not forwarded to a live session");
		assert.equal(requests.at(-1)?.message.content.text, "while you wait");

		const replacementSessionId = randomUUID();
		const replacement = await stageSession(replacementSessionId);
		for (const alias of [firstName, firstSessionId, `subagent-chat-${replacementSessionId}`]) {
			const sent = await launcher.send(alias, { text: `via ${alias}` });
			assert.equal(sent.delivered, true, `${alias}: ${sent.reason}`);
		}
		await vi.waitFor(
			() =>
				assert.deepEqual(replacement.received, [
					`via ${firstName}`,
					`via ${firstSessionId}`,
					`via subagent-chat-${replacementSessionId}`,
				]),
			{ timeout: 10_000, interval: 20 },
		);
		assert.deepEqual(first.received, ["status?"]);

		const outsider = await connect("issue-4639-outsider", { group: "elsewhere" });
		const hidden = await outsider.send(firstName, { text: "who is this?" });
		assert.equal(hidden.reason, "Session not found", "a sender that cannot control the run learns nothing");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a held send for a suspended launching session's released subagent ends with the typed owner-suspended error, and the run's end forgets the subagent (#4639)",
	async () => {
		const { isSubagentRecipientOwnerSuspendedError } = await import(
			"../../packages/intercom/broker/recipient-gone-errors.js"
		);
		const runId = "46390001-3528-413e-84c4-87a43e5037a2";
		const group = `workflow:${runId}`;
		const routeOwner = await connect("issue-4639-suspended-route", { group });
		await routeOwner.registerPendingStageRouteAcknowledged(runId, group, "issue-4639-suspended-capability");
		const stageSessionId = randomUUID();
		const childName = "subagent-worker-suspended-timeout-1";
		const stage = await connect(`subagent-chat-${stageSessionId}`, {
			ownerToken: randomUUID(),
			returnAddress: stageSessionId,
			group,
		});
		await stage.reserveReleasedChildren([{ childName, group, wake: true }]);
		const stageId = stage.sessionId;
		await stage.disconnect();
		const member = await connect("issue-4639-suspended-member", { group });
		await untilGone(member, stageId);

		const refused = await member.send(childName, { text: "anyone there?" });
		assert.equal(refused.delivered, false);
		assert.ok(refused.error !== undefined && isSubagentRecipientOwnerSuspendedError(refused.error), refused.reason);
		assert.equal(refused.reasonCode, "recipient_owner_suspended");
		assert.equal(refused.error.retryable, true);
		assert.deepEqual(refused.error.fields, { target: childName, childName });

		const before = (await member.brokerStatus())?.reservations ?? 0;
		const routeOwnerId = routeOwner.sessionId;
		await routeOwner.disconnect();
		await untilGone(member, routeOwnerId);
		const forgotten = await member.send(childName, { text: "and now?" });
		assert.equal(forgotten.reason, "Session not found", "the run ended: nobody keeps its stage's subagent any more");
		assert.equal((await member.brokerStatus())?.reservations, before - 1);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
