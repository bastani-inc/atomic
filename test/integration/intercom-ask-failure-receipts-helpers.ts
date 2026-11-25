import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import type {
	IntercomClient as IntercomClientClass,
	ReleasedChildReply,
} from "../../packages/intercom/broker/client.js";
import type { Message } from "../../packages/intercom/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");

export type Client = IntercomClientClass;
export type { Message, ReleasedChildReply };

/** Spawning the real broker child is the structural cost of this suite. */
export const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
export const WAIT = { timeout: 10_000, interval: 20 };
/**
 * Structural: the broker child compiles its TypeScript through jiti before it answers, which took longer than
 * {@link WAIT} on a loaded Windows host (#5252).
 */
const BROKER_START_WAIT_MS = 90_000;
/** Starting the broker waits for it, then has room to fail with its own message. */
export const BROKER_START_HOOK_TIMEOUT_MS = BROKER_START_WAIT_MS + 5_000;
/** Long enough for a frame the broker wrote to arrive, so its absence means none was written. */
export const SETTLE_MS = 300;

const ASKER_DIES_ITERATIONS = 30;
/** How long the asker takes to come back. */
const ASKER_RESTART_MS = 1_000;
/**
 * How long an ask's outcome may take to arrive once its asker is back. Generous, so a stalled CI machine shows up as
 * a slow outcome in the log rather than as a lost one; an outcome that never arrives still fails the test.
 */
const OUTCOME_WAIT = { timeout: 30_000, interval: 20 };

export interface Session {
	readonly client: Client;
	/** Every message that arrived, whether or not it was confirmed. */
	readonly received: Message[];
	/** Asks whose recipient the broker said disconnected (the notice an old client gets). */
	readonly peerGone: string[];
}

export function idOf(client: Client): string {
	const id = client.sessionId;
	assert.ok(id);
	return id;
}

/** The failures of `questionId` that reached the session, however they arrived. */
export function failuresOf(session: Session, questionId: string): string[] {
	return [
		...session.received
			.filter((message) => message.replyTo === questionId && message.replyError !== undefined)
			.map((message) => message.id),
		...session.peerGone.filter((replyTo) => replyTo === questionId).map(() => "peer_disconnected"),
	];
}

/** The recipient answers `questionId` on the ask's own reply route, as the `reply` action does. */
export function replyTo(recipient: Session, askerId: string, questionId: string) {
	return recipient.client.send(askerId, {
		text: "port 8080",
		replyTo: questionId,
		requirePendingReply: true,
		expectedRecipientId: askerId,
	});
}

/** The replies to `questionId` that reached the session. */
export function repliesTo(session: Session, questionId: string): Message[] {
	return session.received.filter((message) => message.replyTo === questionId && message.replyError === undefined);
}

export async function createAskFailureReceiptsHarness(tempPrefix: string) {
	const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), tempPrefix)));
	brokerFixture.overrideAgentDir();
	const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
	const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
	const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

	async function startBroker(): Promise<void> {
		const extensionDir = join(repoRoot, "packages/intercom");
		const broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
			stdio: "ignore",
		});
		brokerFixture.trackBroker(broker);
		// A broker retires once no session has been connected for 5 s since it listened. Under load the suite can spend that
		// long before its own sessions register, so the fixture holds a session for this broker until cleanup.
		await brokerFixture.holdSession(
			getBrokerSocketPath(process.platform, brokerFixture.agentDir),
			BROKER_START_WAIT_MS,
		);
	}

	/**
	 * A real client. `confirms`: it confirms each save, as a session does; without it, it receives frames but never
	 * confirms one, as an asker that crashes before saving. `acknowledgesReceipt: false` is a client from before #3761.
	 */
	async function connect(
		name: string,
		options: {
			returnAddress: string;
			preferredSessionId?: string;
			confirms?: boolean;
			acknowledgesReceipt?: boolean;
			ownerToken?: string;
			supervisor?: { capability: string; supervisorSessionId: string };
		},
	): Promise<Session> {
		const client = new IntercomClient(options.returnAddress, {
			...(options.acknowledgesReceipt === false ? {} : { acknowledgesReceipt: true }),
			...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
		});
		const received: Message[] = [];
		const peerGone: string[] = [];
		client.on("message", (_from: object, message: Message) => {
			received.push(message);
			if (options.confirms !== false && options.acknowledgesReceipt !== false) {
				client.acknowledgeReceived(message.id);
			}
		});
		client.on("peer_disconnected", (notice: { replyTo: string }) => peerGone.push(notice.replyTo));
		client.on("error", () => {});
		await client.connect(
			{
				name,
				model: "test-model",
				cwd: repoRoot,
				pid: process.pid,
				status: "idle",
				startedAt: Date.now(),
				lastActivity: Date.now(),
			},
			options.supervisor,
			options.ownerToken,
		);
		brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
		return { client, received, peerGone };
	}

	async function runAskerDiesScenario(mode: 0 | 1 | 2, when: string): Promise<void> {
		const outcomes: string[] = [];
		const outcomeMsByIteration: number[] = [];
		// Sees which sessions the broker still lists, so the asker comes back only once both departures were handled.
		const observer = await connect(`observer-${mode}-5095`, { returnAddress: randomUUID() });
		for (let iteration = 0; iteration < ASKER_DIES_ITERATIONS; iteration++) {
			const label = `asker-dies-${mode}-${iteration}-5095`;
			const askerAddress = { name: `asker-${label}`, returnAddress: randomUUID() };
			const asker = await connect(askerAddress.name, askerAddress);
			const askerId = idOf(asker.client);
			const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
			const recipientId = idOf(recipient.client);
			const questionId = randomUUID();
			const asked = await asker.client.send(`recipient-${label}`, {
				messageId: questionId,
				text: "which port?",
				expectsReply: true,
			});
			assert.equal(asked.delivered, true, asked.reason);
			await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);

			// The asker's connection dies around the reply, as a crashing process's does; the recipient ends at once.
			const socket = (asker.client as unknown as { socket: net.Socket | null }).socket;
			if (mode === 0) socket?.destroy();
			const replying = replyTo(recipient, askerId, questionId).catch(() => undefined);
			if (mode === 1) await sleep(1);
			if (mode !== 0) socket?.destroy();
			void recipient.client.disconnect().catch(() => undefined);
			await replying;
			// Its process restarts, as p28 does, after both departures were handled: on a loaded host the broker can
			// take longer than the restart to handle them, so wait for it to list neither session.
			await vi.waitFor(async () => {
				const listed = (await observer.client.listSessions()).map((session) => session.id);
				assert.ok(!listed.includes(askerId) && !listed.includes(recipientId), "both departures were handled");
			}, WAIT);
			await sleep(ASKER_RESTART_MS);
			const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
			const backAt = Date.now();
			const seen = () =>
				new Set(
					[...asker.received, ...back.received]
						.filter((message) => message.replyTo === questionId)
						.map((message) => (message.replyError === undefined ? "reply" : "failure")),
				);
			await vi
				.waitFor(() => assert.ok(seen().size > 0, "the ask has an outcome"), OUTCOME_WAIT)
				.catch(() => undefined);
			const outcomeMs = Date.now() - backAt;
			await sleep(SETTLE_MS);
			const ids = new Set(
				[...asker.received, ...back.received].filter((m) => m.replyTo === questionId).map((m) => m.id),
			);
			outcomes.push(
				ids.size === 1
					? `#${iteration}: outcomes=1`
					: `#${iteration}: outcomes=${ids.size} after ${outcomeMs} ms before=${JSON.stringify(asker.received.filter((m) => m.replyTo === questionId).map((m) => m.id.slice(0, 12)))} back=${JSON.stringify(back.received.filter((m) => m.replyTo === questionId).map((m) => m.id.slice(0, 12)))}`,
			);
			outcomeMsByIteration.push(outcomeMs);
			await back.client.disconnect();
		}
		// How long each outcome took once the asker was back, so a slow one is visible in the log.
		process.stderr.write(`asker dies ${when}: outcome ms per iteration ${JSON.stringify(outcomeMsByIteration)}\n`);
		assert.deepEqual(
			outcomes,
			outcomes.map((_, iteration) => `#${iteration}: outcomes=1`),
			"each ask has exactly one outcome, the reply or the failure",
		);
	}

	return {
		startBroker,
		cleanup: () => brokerFixture.cleanup(),
		connect,
		runAskerDiesScenario,
	};
}
