import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import {
	type BrokerNode,
	TWO_BROKER_STORAGE_PREFIX,
	type TwoBrokerClient,
	TwoBrokerHarness,
} from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #4992: an ask delivered to a subagent that was then released is parked for the subagent's owner. When the owner
 * leaves, ended or only away, the ask ends, and its asker is told once on whichever broker it is connected to, as an
 * asker on the owner's own broker always was.
 */

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const REAL_BROKERS_TEST_TIMEOUT_MS = 60_000;
/** Two broker restarts and a reconnect on top of the ordinary scenario. */
const RESTART_TEST_TIMEOUT_MS = 120_000;
const WAIT = { timeout: 15_000, interval: 25 };
/** How long a failure that must not arrive twice is given to show up. */
const SETTLE_MS = 1_500;
const PENDING_ASKS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_pending_asks`;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

interface ParkedAsk {
	readonly askId: string;
	readonly asker: TwoBrokerClient;
	readonly owner: TwoBrokerClient;
	/** Every way the asker was told its ask ended: a failed-ask message or a `peer_disconnected` notice. */
	readonly failures: string[];
}

/** Watch an asker client for the failures of `askId`, in either form a broker sends them. */
function watchFailures(asker: TwoBrokerClient, askId: string, failures: string[]): void {
	asker.client.on("message", (_from: unknown, message: { replyTo?: string; replyError?: string }) => {
		if (message.replyTo === askId && message.replyError !== undefined) failures.push(`message:${message.replyError}`);
	});
	asker.client.on("peer_disconnected", (notice: { replyTo: string }) => {
		if (notice.replyTo === askId) failures.push("peer_disconnected");
	});
}

async function sharedRoute(askId: string): Promise<{ park_owner: string | null } | undefined> {
	const database = await harness.openSharedStorage("a");
	try {
		return await database.get<{ park_owner: string | null }>(
			`SELECT park_owner FROM ${PENDING_ASKS_TABLE} WHERE message_id = ?`,
			askId,
		);
	} finally {
		await database.close();
	}
}

/**
 * Owner O and its subagent C on node b, asker A on `askerNode`: A asks C, C saves the ask, then O releases C and C
 * leaves, so the ask is parked for O.
 */
async function parkedAsk(askerNode: BrokerNode): Promise<ParkedAsk> {
	const group = unique("parked");
	const askId = randomUUID();
	const failures: string[] = [];
	const asker = await harness.connect(askerNode, unique("asker"), {
		group,
		beforeConnect: (client) => watchFailures(client, askId, failures),
	});
	const owner = await harness.connect("b", unique("owner"), { group, supervisorOwnerToken: randomUUID() });
	const childName = unique("child");
	const authorization = await owner.client.authorizeSupervisorChild(childName);
	const child = await harness.connect("b", childName, {
		group,
		supervisor: { capability: authorization.capability, supervisorSessionId: authorization.supervisorSessionId },
	});
	const sent = await asker.client.send(child.sessionId, { messageId: askId, text: "ready?", expectsReply: true });
	assert.equal(sent.delivered, true, sent.reason);
	await vi.waitFor(() => assert.equal(child.messagesWithId(askId).length, 1), WAIT);
	await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
	await harness.disconnect(child);
	if (askerNode === "a") {
		// The asker is on another broker: its route is in the shared database, parked for the owner.
		await vi.waitFor(async () => assert.equal((await sharedRoute(askId))?.park_owner, owner.sessionId), WAIT);
	} else {
		await sleep(250);
	}
	assert.deepEqual(failures, [], "a released subagent's ask is still open");
	return { askId, asker, owner, failures };
}

/** The client leaves: ended, or only away when `resumable`. */
async function leave(client: TwoBrokerClient, options: { readonly resumable?: boolean } = {}): Promise<void> {
	await client.client.disconnect(options);
	client.disconnected = true;
}

async function exactlyOneFailure(scene: ParkedAsk): Promise<void> {
	await vi.waitFor(() => assert.equal(scene.failures.length, 1), WAIT);
	await sleep(SETTLE_MS);
	assert.equal(scene.failures.length, 1, `told once, not ${JSON.stringify(scene.failures)}`);
}

test(
	"an asker on another broker gets exactly one failure when a released subagent's owner ends (#4992)",
	async () => {
		const scene = await parkedAsk("a");
		await leave(scene.owner);
		await exactlyOneFailure(scene);
		assert.match(scene.failures[0]!, /^message:Session ".+" ended before replying$/);
		await vi.waitFor(async () => assert.equal(await sharedRoute(scene.askId), undefined), WAIT);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an asker on another broker gets exactly one failure when a released subagent's owner goes away, as on the owner's broker (#4992)",
	async () => {
		const remote = await parkedAsk("a");
		const local = await parkedAsk("b");
		await leave(remote.owner, { resumable: true });
		await leave(local.owner, { resumable: true });
		await exactlyOneFailure(local);
		await exactlyOneFailure(remote);
		// #5004: a client that confirms saves gets the failed-ask message on one broker too, so both read alike.
		assert.match(local.failures[0]!, /^message:Session ".+" ended before replying$/);
		assert.match(remote.failures[0]!, /^message:Session ".+" ended before replying$/);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an asker on the owner's broker is still told once when the owner ends (#4992)",
	async () => {
		const scene = await parkedAsk("b");
		await leave(scene.owner);
		await exactlyOneFailure(scene);
		assert.match(scene.failures[0]!, /^message:Session ".+" ended before replying$/);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an away asker on another broker gets the failure once when it is back, and not again after both brokers restart (#4992)",
	async () => {
		const scene = await parkedAsk("a");
		const { asker } = scene;
		const askerId = asker.sessionId;
		await leave(asker, { resumable: true });
		await leave(scene.owner);
		await vi.waitFor(async () => assert.equal(await sharedRoute(scene.askId), undefined), WAIT);
		const back = await harness.connect("a", asker.name, {
			group: asker.group,
			returnAddress: asker.returnAddress,
			preferredSessionId: askerId,
			beforeConnect: (client) => watchFailures(client, scene.askId, scene.failures),
		});
		await exactlyOneFailure(scene);
		assert.match(scene.failures[0]!, /^message:Session ".+" ended before replying$/);

		await harness.shutdownBroker("a");
		await harness.shutdownBroker("b");
		await harness.ensureBrokersRunning();
		await harness.connect("a", back.name, {
			group: back.group,
			returnAddress: back.returnAddress,
			preferredSessionId: askerId,
			beforeConnect: (client) => watchFailures(client, scene.askId, scene.failures),
		});
		await sleep(SETTLE_MS);
		assert.equal(scene.failures.length, 1, `told once, not ${JSON.stringify(scene.failures)}`);
	},
	RESTART_TEST_TIMEOUT_MS,
);
