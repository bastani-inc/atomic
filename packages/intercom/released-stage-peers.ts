import { randomUUID } from "node:crypto";
import type { IntercomClient } from "./broker/client.js";
import type { JsonWireValue } from "./broker/framing.js";
import { hostedSessionErrorFor } from "./broker/hosted-session-errors.js";
import { HOSTED_SESSION_FRAME_MAX, validateHostSessionsFrame } from "./broker/hosted-sessions.js";
import { normalizeGroup } from "./group.js";
import { formatAttachments, resolveIntercomPresenceName, toError } from "./intercom-utils.js";
import { reconnectDelayMs } from "./reconnect-backoff.js";
import { IntercomClientDisconnectedError } from "./recoverable-disconnect.js";
import type { HostedSessionFrameItem, Message, SessionInfo } from "./types.js";

/** Workflows -> Intercom: a completed stage released its session and still needs a peer. */
export const RELEASED_STAGE_EVENT = "atomic:workflow-released-stage";

const RELEASED_STAGE_STATUS = "closed · reply: post-mortem only";

/**
 * Ids plus one loader closure supplied by the workflow host. A released stage's
 * peer holds no session, session manager, or transcript: `answer` reopens the
 * stage from its saved conversation when an ask arrives and returns its reply.
 */
export interface ReleasedStageAnnouncement {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	readonly sessionId: string;
	readonly group: string;
	readonly model?: string;
	readonly liveRoute?: {
		readonly stageKeys: readonly string[];
		readonly capability: string;
	};
	readonly answer: (content: string) => Promise<string>;
}

export function isReleasedStageAnnouncement(value: object): value is ReleasedStageAnnouncement {
	const route = value as Partial<ReleasedStageAnnouncement>;
	const live = route.liveRoute;
	return (
		typeof route.runId === "string" &&
		route.runId.length > 0 &&
		typeof route.stageId === "string" &&
		route.stageId.length > 0 &&
		typeof route.stageName === "string" &&
		typeof route.sessionId === "string" &&
		route.sessionId.length > 0 &&
		typeof route.group === "string" &&
		(route.model === undefined || typeof route.model === "string") &&
		typeof route.answer === "function" &&
		(live === undefined ||
			(typeof live.capability === "string" &&
				Array.isArray(live.stageKeys) &&
				live.stageKeys.every((key) => typeof key === "string")))
	);
}

export interface ReleasedStagePeersDeps {
	/** Makes sure a broker is running before the peers' connection connects. */
	prepare(): Promise<void>;
	createClient(returnAddress: string): IntercomClient;
	cwd(): string;
	/**
	 * Anything that is not a blocking ask goes where a closed stage's late messages
	 * always went: the owning host session.
	 */
	relay(from: SessionInfo, message: Message, channel?: "supervisor"): void;
}

interface ReleasedStagePeer {
	route: ReleasedStageAnnouncement;
	/** The connection the peer is hosted on, or being hosted on. */
	hostedOn?: IntercomClient;
	/** The peer's broker session id on `hostedOn`, once the broker assigned it. */
	sessionId?: string;
	/** Settles when hosting on `hostedOn` ends, with its failure if it failed. */
	hosting?: Promise<Error | undefined>;
	readonly answering: Set<string>;
}

function peerKey(route: Pick<ReleasedStageAnnouncement, "runId" | "stageId">): string {
	return `${route.runId}\0${route.stageId}`;
}

/** Whether an announcement registers the stage exactly as the peer is registered already. */
function sameRegistration(left: ReleasedStageAnnouncement, right: ReleasedStageAnnouncement): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.group === right.group &&
		left.model === right.model &&
		left.liveRoute?.capability === right.liveRoute?.capability &&
		(left.liveRoute?.stageKeys ?? []).join("\0") === (right.liveRoute?.stageKeys ?? []).join("\0")
	);
}

/** The ask text the reopened stage conversation receives; its final reply is relayed to the asker. */
function askPrompt(from: SessionInfo, message: Message): string {
	const attachments = message.content.attachments?.length ? formatAttachments(message.content.attachments) : "";
	return [
		`**📨 From ${from.name || from.id}** (${from.cwd})`,
		"",
		`${message.content.text}${attachments}`,
		"",
		"---",
		"This workflow stage finished earlier and was reopened from its saved conversation to answer this ask.",
		"Answer in your final message; Atomic delivers it to the asker. Do not call the intercom tool to reply.",
	].join("\n");
}

/**
 * Keeps one lightweight Intercom peer per released workflow stage. The peer takes
 * the place of the disposed stage session: same presence name and group, listed
 * as `closed · reply: post-mortem only`. A blocking ask reopens the stage through
 * the workflow host's loader, never rerunning the workflow, and the peer sends
 * the stage's final reply. Every other message reaches the host session.
 *
 * #4642: every peer is a session hosted on one shared broker connection, opened
 * with the first peer and closed with the last, so a released stage costs an
 * index entry here and at the broker, never a socket or timer of its own.
 */
export class ReleasedStagePeers {
	private readonly peers = new Map<string, ReleasedStagePeer>();
	private readonly hostAddress = `released-stages:${randomUUID()}`;
	private client: IntercomClient | null = null;
	private connecting: Promise<IntercomClient> | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempt = 0;
	/** Bumped by `disconnectAll`, so a connection still being opened is closed instead of kept. */
	private epoch = 0;

	constructor(private readonly deps: ReleasedStagePeersDeps) {}

	get size(): number {
		return this.peers.size;
	}

	/**
	 * Resolves once the peer is hosted, or rejects when that attempt fails (the connection keeps retrying). Adopting a
	 * stage again with the same registration only takes the new announcement's loader; otherwise it replaces the peer.
	 * An announcement the broker would refuse is rejected alone with `HostedSessionRequestError`, before it is kept.
	 */
	async adopt(route: ReleasedStageAnnouncement): Promise<void> {
		const wire: JsonWireValue = JSON.parse(JSON.stringify([this.hostedSession(route)]));
		const validation = validateHostSessionsFrame(wire);
		if (!validation.ok) throw hostedSessionErrorFor(validation.refusal);
		const key = peerKey(route);
		const previous = this.peers.get(key);
		if (previous !== undefined && sameRegistration(previous.route, route)) {
			previous.route = route;
			await this.host(previous);
			return;
		}
		const peer: ReleasedStagePeer = { route, answering: new Set() };
		this.peers.set(key, peer);
		if (previous !== undefined) await this.unhost(previous);
		await this.host(peer);
	}

	async disconnectAll(): Promise<void> {
		this.epoch += 1;
		this.peers.clear();
		clearTimeout(this.reconnectTimer ?? undefined);
		this.reconnectTimer = null;
		this.reconnectAttempt = 0;
		const client = this.client;
		this.client = null;
		// An attempt still connecting sees the new epoch and closes its own connection.
		await Promise.allSettled([this.connecting]);
		await client?.disconnect();
	}

	private async host(peer: ReleasedStagePeer): Promise<void> {
		let failure: Error | undefined;
		try {
			const client = await this.connect();
			if (peer.hostedOn !== client) void this.hostPending(client);
			failure = await peer.hosting;
		} catch (error) {
			failure = toError(error);
		}
		if (failure === undefined) return;
		this.scheduleReconnect();
		throw failure;
	}

	/** Hosts every peer not yet hosted on `client`, in frames of at most 500; settles with the first failure. */
	private async hostPending(client: IntercomClient): Promise<Error | undefined> {
		const pending = [...this.peers.values()].filter((peer) => peer.hostedOn !== client);
		const requests: Promise<Error | undefined>[] = [];
		for (let start = 0; start < pending.length; start += HOSTED_SESSION_FRAME_MAX) {
			const chunk = pending.slice(start, start + HOSTED_SESSION_FRAME_MAX);
			const byKey = new Map(chunk.map((peer) => [peerKey(peer.route), peer]));
			const request = client.hostSessions(chunk.map((peer) => this.hostedSession(peer.route))).then(
				(assigned): undefined => {
					for (const { key, sessionId } of assigned) {
						const peer = byKey.get(key);
						if (peer === undefined || peer.hostedOn !== client) continue;
						peer.sessionId = sessionId;
					}
					return undefined;
				},
				(error) => {
					// Hosting them again on this connection is up to the next attempt.
					for (const peer of chunk) if (peer.hostedOn === client) peer.hostedOn = undefined;
					return toError(error);
				},
			);
			for (const peer of chunk) {
				peer.hostedOn = client;
				peer.sessionId = undefined;
				peer.hosting = request;
			}
			requests.push(request);
		}
		return (await Promise.all(requests)).find((failure) => failure !== undefined);
	}

	private hostedSession(route: ReleasedStageAnnouncement): HostedSessionFrameItem {
		const group = normalizeGroup(route.group);
		const now = Date.now();
		return {
			key: peerKey(route),
			session: {
				name: resolveIntercomPresenceName(undefined, route.sessionId),
				cwd: this.deps.cwd(),
				model: route.model ?? "unknown",
				pid: process.pid,
				startedAt: now,
				lastActivity: now,
				status: RELEASED_STAGE_STATUS,
				replyCapability: "live",
				groups: [group],
				group,
			},
			returnAddress: `${route.sessionId}:released-stage`,
			...(route.liveRoute === undefined || route.liveRoute.stageKeys.length === 0
				? {}
				: {
						liveRoute: {
							runId: route.runId,
							stageKeys: [...route.liveRoute.stageKeys],
							capability: route.liveRoute.capability,
						},
					}),
		};
	}

	/** Removes a replaced peer's broker session; a peer whose connection is gone left the broker with it. */
	private async unhost(peer: ReleasedStagePeer): Promise<void> {
		await peer.hosting;
		const { hostedOn, sessionId } = peer;
		peer.hostedOn = undefined;
		peer.sessionId = undefined;
		if (sessionId !== undefined && hostedOn === this.client) await hostedOn.unhostSessions([sessionId]);
	}

	private connect(): Promise<IntercomClient> {
		if (this.client !== null) return Promise.resolve(this.client);
		if (this.connecting === null) {
			const attempt = this.connectOnce();
			this.connecting = attempt;
			const settled = (): void => {
				this.connecting = null;
			};
			attempt.then(settled, settled);
		}
		return this.connecting;
	}

	private async connectOnce(): Promise<IntercomClient> {
		const epoch = this.epoch;
		await this.deps.prepare();
		if (epoch !== this.epoch) throw new IntercomClientDisconnectedError();
		const client = this.deps.createClient(this.hostAddress);
		client.on("hosted_message", (recipient: string, from: SessionInfo, message: Message, channel?: "supervisor") => {
			if (this.client === client) this.receive(client, recipient, from, message, channel);
		});
		// Peers keep naming the closed connection until they are hosted on the next one; nothing it sends is read.
		client.on("disconnected", () => {
			if (this.client !== client) return;
			this.client = null;
			this.scheduleReconnect();
		});
		client.on("error", () => {
			// Reconnect runs from the disconnect path; broker socket noise stays out of the TUI.
		});
		const now = Date.now();
		const group = this.hostAddress;
		try {
			await client.connect(
				{
					cwd: this.deps.cwd(),
					model: "unknown",
					pid: process.pid,
					startedAt: now,
					lastActivity: now,
					recipientPurpose: "control",
					groups: [group],
					group,
				},
				undefined,
				undefined,
				undefined,
				group,
			);
		} catch (error) {
			await client.disconnect();
			throw error;
		}
		if (epoch !== this.epoch) {
			await client.disconnect();
			throw new IntercomClientDisconnectedError();
		}
		this.client = client;
		this.reconnectAttempt = 0;
		return client;
	}

	/** One timer for every peer: reconnects, then hosts every peer the broker does not have yet. */
	private scheduleReconnect(): void {
		if (this.reconnectTimer !== null || this.peers.size === 0) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.reconnectAttempt += 1;
			void this.connect()
				.then((client) => this.hostPending(client))
				.then(
					(failure) => {
						if (failure !== undefined) this.scheduleReconnect();
					},
					() => this.scheduleReconnect(),
				);
		}, reconnectDelayMs(this.reconnectAttempt));
	}

	private receive(
		client: IntercomClient,
		recipient: string,
		from: SessionInfo,
		message: Message,
		channel: "supervisor" | undefined,
	): void {
		// Broker session ids are never reused, so at most one peer has this one.
		const peer = [...this.peers.values()].find((candidate) => candidate.sessionId === recipient);
		// A session this connection no longer hosts: the broker told its askers it left.
		if (peer === undefined) return;
		if (message.expectsReply !== true || channel !== undefined) {
			this.deps.relay(from, message, channel);
			return;
		}
		if (peer.answering.has(message.id)) return;
		peer.answering.add(message.id);
		void this.answer(peer, client, recipient, from, message).finally(() => peer.answering.delete(message.id));
	}

	private async answer(
		peer: ReleasedStagePeer,
		client: IntercomClient,
		recipient: string,
		from: SessionInfo,
		message: Message,
	): Promise<void> {
		let reply: { text: string; replyError?: string };
		try {
			reply = { text: await peer.route.answer(askPrompt(from, message)) };
		} catch (error) {
			const failure = `Released workflow stage could not answer: ${toError(error).message}`;
			reply = { text: failure, replyError: failure };
		}
		if (peer.sessionId !== recipient || this.client !== client) return;
		try {
			await client.send(from.id, {
				...reply,
				replyTo: message.id,
				requirePendingReply: true,
				hostedSender: recipient,
			});
		} catch {
			// The asker left or timed out, or this connection closed; the broker already settled that ask.
		}
	}
}
