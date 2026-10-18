import type { IntercomClient } from "./broker/client.js";
import { normalizeGroup } from "./group.js";
import { formatAttachments, resolveIntercomPresenceName, toError } from "./intercom-utils.js";
import { IntercomLiveRouteRefusedError } from "./live-route-refusal.js";
import { reconnectDelayMs } from "./reconnect-backoff.js";
import type { Message, SessionInfo } from "./types.js";

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
	/** Makes sure a broker is running before a peer connects. */
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
	readonly route: ReleasedStageAnnouncement;
	readonly returnAddress: string;
	client: IntercomClient | null;
	connecting: Promise<void> | null;
	reconnectTimer: NodeJS.Timeout | null;
	reconnectAttempt: number;
	closed: boolean;
	readonly answering: Set<string>;
}

function peerKey(route: Pick<ReleasedStageAnnouncement, "runId" | "stageId">): string {
	return `${route.runId}\0${route.stageId}`;
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
 */
export class ReleasedStagePeers {
	private readonly peers = new Map<string, ReleasedStagePeer>();

	constructor(private readonly deps: ReleasedStagePeersDeps) {}

	get size(): number {
		return this.peers.size;
	}

	/** Resolves once the peer is registered, or rejects when the first connection attempt fails (it keeps retrying). */
	async adopt(route: ReleasedStageAnnouncement): Promise<void> {
		const key = peerKey(route);
		const previous = this.peers.get(key);
		if (previous !== undefined) await this.close(previous);
		const peer: ReleasedStagePeer = {
			route,
			returnAddress: `${route.sessionId}:released-stage`,
			client: null,
			connecting: null,
			reconnectTimer: null,
			reconnectAttempt: 0,
			closed: false,
			answering: new Set(),
		};
		this.peers.set(key, peer);
		await this.connect(peer);
	}

	async disconnectAll(): Promise<void> {
		const peers = [...this.peers.values()];
		this.peers.clear();
		await Promise.all(peers.map((peer) => this.close(peer)));
	}

	private connect(peer: ReleasedStagePeer): Promise<void> {
		if (peer.connecting !== null) return peer.connecting;
		const attempt = this.connectOnce(peer).then(
			() => {
				peer.reconnectAttempt = 0;
			},
			(error) => {
				this.scheduleReconnect(peer);
				throw toError(error);
			},
		);
		peer.connecting = attempt;
		const settled = (): void => {
			if (peer.connecting === attempt) peer.connecting = null;
		};
		attempt.then(settled, settled);
		return attempt;
	}

	private async connectOnce(peer: ReleasedStagePeer): Promise<void> {
		const { route } = peer;
		await this.deps.prepare();
		if (peer.closed) return;
		const group = normalizeGroup(route.group);
		const client = this.deps.createClient(peer.returnAddress);
		client.on("message", (from: SessionInfo, message: Message, channel?: "supervisor") => {
			if (peer.client !== client) return;
			this.receive(peer, client, from, message, channel);
		});
		client.on("disconnected", () => {
			if (peer.client !== client) return;
			peer.client = null;
			this.scheduleReconnect(peer);
		});
		client.on("error", () => {
			// Reconnect runs from the disconnect path; broker socket noise stays out of the TUI.
		});
		peer.client = client;
		try {
			const now = Date.now();
			await client.connect(
				{
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
				undefined,
				undefined,
				undefined,
				group,
			);
			if (route.liveRoute !== undefined && route.liveRoute.stageKeys.length > 0) {
				try {
					await client.registerLiveWorkflowStageRoute(
						route.runId,
						[...route.liveRoute.stageKeys],
						route.liveRoute.capability,
					);
				} catch (error) {
					// The peer stays reachable by name; only the `workflow:` alias was refused.
					if (!(error instanceof IntercomLiveRouteRefusedError)) throw error;
				}
			}
			if (peer.closed) {
				peer.client = null;
				await client.disconnect();
			}
		} catch (error) {
			if (peer.client === client) peer.client = null;
			try {
				await client.disconnect();
			} catch {
				// The failed connection is already gone.
			}
			throw error;
		}
	}

	private scheduleReconnect(peer: ReleasedStagePeer): void {
		if (peer.closed || peer.reconnectTimer !== null || peer.connecting !== null) return;
		peer.reconnectTimer = setTimeout(() => {
			peer.reconnectTimer = null;
			if (peer.closed) return;
			peer.reconnectAttempt += 1;
			this.connect(peer).catch(() => {
				// connect() schedules the next attempt itself.
			});
		}, reconnectDelayMs(peer.reconnectAttempt));
	}

	private receive(
		peer: ReleasedStagePeer,
		client: IntercomClient,
		from: SessionInfo,
		message: Message,
		channel: "supervisor" | undefined,
	): void {
		if (message.expectsReply !== true || channel !== undefined) {
			this.deps.relay(from, message, channel);
			return;
		}
		if (peer.answering.has(message.id)) return;
		peer.answering.add(message.id);
		void this.answer(peer, client, from, message).finally(() => peer.answering.delete(message.id));
	}

	private async answer(
		peer: ReleasedStagePeer,
		client: IntercomClient,
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
		if (peer.closed || !client.isConnected()) return;
		try {
			await client.send(from.id, { ...reply, replyTo: message.id, requirePendingReply: true });
		} catch {
			// The asker left or timed out; the broker already settled that ask.
		}
	}

	private async close(peer: ReleasedStagePeer): Promise<void> {
		peer.closed = true;
		if (peer.reconnectTimer !== null) clearTimeout(peer.reconnectTimer);
		peer.reconnectTimer = null;
		if (this.peers.get(peerKey(peer.route)) === peer) this.peers.delete(peerKey(peer.route));
		try {
			await peer.connecting;
		} catch {
			// A failed attempt leaves nothing to disconnect.
		}
		const client = peer.client;
		peer.client = null;
		if (client === null) return;
		try {
			await client.disconnect();
		} catch {
			// The broker connection is already gone.
		}
	}
}
