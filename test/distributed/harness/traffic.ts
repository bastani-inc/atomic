import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { UNCERTAIN_RECEIPT_REASON } from "../../../packages/intercom/broker/recipient-receipts.js";
import { adminSql, type Node, type NodeClient } from "./cluster.js";

/** Node names: a, b, c, ... */
export function nodeNames(count: number): string[] {
	return Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
}

/** How many wake-up connections are listening on the primary right now. */
export function listeners(): number {
	return Number(
		adminSql(
			"SELECT count(*) FROM pg_stat_activity WHERE application_name = 'atomic-listen' AND query LIKE 'LISTEN%' AND backend_type = 'client backend'",
		),
	);
}

export interface SentMessage {
	readonly id: string;
	/** Sender and receiver client names. */
	readonly from: string;
	readonly to: string;
	readonly k: number;
	readonly text: string;
	readonly sentAt: number;
	/** How long it took to arrive, once it has. */
	latencyMs(): number;
}

export interface SendOutcome {
	readonly accepted: boolean;
	/**
	 * Not accepted, but it may still arrive: the last attempt lost its connection, or the recipient did not confirm
	 * the save in time. It may arrive at most once.
	 */
	readonly uncertain?: true;
	readonly attempts: number;
	readonly reason?: string;
}

/**
 * Sends one message as a session's Intercom tool does after a failure it may retry, with the same message id each time,
 * so a broker that already took it answers from what it recorded and does not deliver it twice. A refusal that names a
 * route or storage that is unavailable for now, an unconfirmed save, and a lost connection are retried until
 * `deadlineMs`; any other refusal is final.
 */
export async function sendOnce(
	sender: () => NodeClient | Promise<NodeClient>,
	to: string,
	text: string,
	id: string,
	deadlineMs = 60_000,
): Promise<SendOutcome> {
	const deadline = performance.now() + deadlineMs;
	let lastReason = "";
	let uncertain = false;
	for (let attempts = 1; ; attempts++) {
		try {
			const client = await sender();
			const result = await client.client.send(to, { text, messageId: id });
			if (result.delivered || result.queued === true) return { accepted: true, attempts };
			lastReason = `${result.reasonCode ?? ""} ${result.reason ?? ""}`.trim();
			uncertain = result.reason === UNCERTAIN_RECEIPT_REASON;
			const retryable =
				uncertain ||
				result.reasonCode === "route_unavailable" ||
				/unavailable|try again|retry/i.test(result.reason ?? "");
			if (!retryable) return { accepted: false, attempts, reason: lastReason };
		} catch (error) {
			lastReason = error instanceof Error ? error.message : String(error);
			uncertain = true;
		}
		if (performance.now() > deadline)
			return { accepted: false, ...(uncertain ? { uncertain: true as const } : {}), attempts, reason: lastReason };
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/**
 * `sender` sends `count` numbered messages to `target` (an id or a name), one at a time. `receiver` finds the client
 * that receives them, once it exists, to time their arrival. Throws if any send is refused for good.
 */
export async function sendSequence(
	sender: NodeClient | (() => NodeClient | Promise<NodeClient>),
	target: string,
	receiverName: string,
	count: number,
	tag: string,
	receiver: () => NodeClient | undefined = () => undefined,
	senderName = typeof sender === "function" ? "sender" : sender.name,
): Promise<SentMessage[]> {
	const sent: SentMessage[] = [];
	for (let k = 1; k <= count; k++) {
		const id = randomUUID();
		const text = `${tag} ${senderName}->${receiverName} ${k}`;
		const sentAt = performance.now();
		const outcome = await sendOnce(typeof sender === "function" ? sender : () => sender, target, text, id);
		assert.ok(outcome.accepted, `${text} was refused: ${outcome.reason}`);
		sent.push({
			id,
			from: senderName,
			to: receiverName,
			k,
			text,
			sentAt,
			latencyMs: () => {
				const frame = receiver()?.received.find((candidate) => candidate.message.id === id);
				return frame === undefined ? Number.POSITIVE_INFINITY : frame.at - sentAt;
			},
		});
	}
	return sent;
}

/**
 * Every sender sends `count` numbered messages to every receiver other than itself, one at a time per pair and all
 * pairs at once. Throws if any send is refused for good.
 */
export async function sendAll(
	senders: readonly NodeClient[],
	receivers: readonly NodeClient[],
	count: number,
	tag: string,
): Promise<SentMessage[]> {
	const batches = await Promise.all(
		senders.flatMap((sender) =>
			receivers
				.filter((receiver) => receiver !== sender)
				.map((receiver) => sendSequence(sender, receiver.sessionId, receiver.name, count, tag, () => receiver)),
		),
	);
	return batches.flat();
}

/**
 * Asserts `receiver` got each of `expected`, and each sender's messages in the order they were sent, taking each
 * message at its first arrival. A message arrives once per connection: the broker sends one again only to a later
 * connection of the session, when it never learned that the earlier one saved it, and the session's inbox keeps one copy
 * by its id (#3761). Throws while any is still missing, so it can be polled. Returns how many repeats it saw.
 */
export function deliveredInOrder(receiver: NodeClient, expected: readonly SentMessage[]): number {
	const connections = new Map<string, number[]>();
	for (const frame of receiver.received) {
		const seen = connections.get(frame.message.id) ?? [];
		seen.push(frame.connection ?? 0);
		connections.set(frame.message.id, seen);
	}
	const twiceOnOneConnection = [...connections]
		.filter(([, seen]) => new Set(seen).size !== seen.length)
		.map(([id]) => id);
	assert.deepEqual(twiceOnOneConnection, [], `${receiver.name} got these message ids twice on one connection`);
	const missing = expected.filter((message) => !connections.has(message.id));
	assert.equal(missing.length, 0, `${receiver.name} is missing ${missing.map((message) => message.text).join(", ")}`);
	const ids = new Set(expected.map((message) => message.id));
	const order = new Map(expected.map((message) => [message.id, message]));
	const first = new Set<string>();
	const lastBySender = new Map<string, { readonly message: SentMessage; readonly at: number }>();
	for (const frame of receiver.received) {
		if (!ids.has(frame.message.id) || first.has(frame.message.id)) continue;
		first.add(frame.message.id);
		const message = order.get(frame.message.id)!;
		const previous = lastBySender.get(message.from);
		if (previous !== undefined && message.k <= previous.message.k) {
			const ms = (value: number) => `${Math.round(value)} ms`;
			assert.fail(
				`${receiver.name} got "${message.text}" (sent at ${ms(message.sentAt)}, arrived at ${ms(frame.at)}) after "${previous.message.text}" (sent at ${ms(previous.message.sentAt)}, arrived at ${ms(previous.at)})`,
			);
		}
		lastBySender.set(message.from, { message, at: frame.at });
	}
	return [...connections.values()].reduce((repeats, seen) => repeats + seen.length - 1, 0);
}

/**
 * An Intercom session of a node that keeps its id: when its connection is lost, as when its broker dies, it registers
 * again with the same id on its node's broker, as a session's Intercom extension does.
 */
export class Peer {
	readonly connections: NodeClient[] = [];
	private connecting: Promise<NodeClient> | undefined;

	private constructor(
		readonly node: Node,
		readonly name: string,
		readonly id: string,
		readonly returnAddress: string,
		readonly group: string,
	) {}

	static async connect(node: Node, name: string, group: string): Promise<Peer> {
		const peer = new Peer(node, name, randomUUID(), randomUUID(), group);
		await peer.client();
		return peer;
	}

	/** The live connection, registering again first when the last one was lost. */
	client(): Promise<NodeClient> {
		const current = this.connections.at(-1);
		if (current !== undefined && !current.disconnected) return Promise.resolve(current);
		this.connecting ??= this.node
			.connect(this.name, { preferredSessionId: this.id, returnAddress: this.returnAddress, group: this.group })
			.then((client) => {
				this.connections.push(client);
				return client;
			})
			.finally(() => {
				this.connecting = undefined;
			});
		return this.connecting;
	}

	/** Every message any of its connections received, in the order they arrived, each with its connection's number. */
	received(): NodeClient {
		const received = this.connections
			.flatMap((connection, index) => connection.received.map((frame) => ({ ...frame, connection: index })))
			.sort((left, right) => left.at - right.at);
		return { name: this.name, received } as unknown as NodeClient;
	}
}

export interface TrafficResult {
	/** Sends a broker accepted: each must arrive exactly once, in order per sender. */
	readonly accepted: SentMessage[];
	/** Sends refused for good: none may arrive. */
	readonly refused: { readonly id: string; readonly to: string; readonly reason?: string }[];
	/** Sends whose outcome stayed unknown: each may arrive, at most once. */
	readonly uncertain: { readonly id: string; readonly to: string; readonly reason?: string }[];
}

/**
 * Every peer sends numbered messages to every other peer, one at a time per pair, `paceMs` apart, until `stop()`.
 * A send that fails in a way it may retry is retried with the same message id.
 */
export function startTraffic(peers: readonly Peer[], tag: string, paceMs = 300): { stop(): Promise<TrafficResult> } {
	let stopping = false;
	const accepted: SentMessage[] = [];
	const refused: TrafficResult["refused"][number][] = [];
	const uncertain: TrafficResult["uncertain"][number][] = [];
	const lanes = peers.flatMap((sender) =>
		peers
			.filter((receiver) => receiver !== sender)
			.map(async (receiver) => {
				for (let k = 1; !stopping; k++) {
					const id = randomUUID();
					const text = `${tag} ${sender.name}->${receiver.name} ${k}`;
					const sentAt = performance.now();
					const outcome = await sendOnce(() => sender.client(), receiver.id, text, id, 90_000);
					if (outcome.accepted)
						accepted.push({
							id,
							from: sender.name,
							to: receiver.name,
							k,
							text,
							sentAt,
							latencyMs: () => {
								const frame = receiver.received().received.find((candidate) => candidate.message.id === id);
								return frame === undefined ? Number.POSITIVE_INFINITY : frame.at - sentAt;
							},
						});
					else if (outcome.uncertain) uncertain.push({ id, to: receiver.name, reason: outcome.reason });
					else refused.push({ id, to: receiver.name, reason: outcome.reason });
					await new Promise((resolve) => setTimeout(resolve, paceMs));
				}
			}),
	);
	return {
		async stop() {
			stopping = true;
			await Promise.all(lanes);
			return { accepted, refused, uncertain };
		},
	};
}
