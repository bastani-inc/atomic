import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

/**
 * #5146: the broker's presence fan-out. Every member of a group must learn every other member's latest presence, but
 * the frames that carry it may not grow with the square of the changes: a burst of changes reaches each recipient as at
 * most one frame per changed session per coalescing interval, and an update that changes nothing visible reaches no
 * one. The sessions here register without a protocol range, as a client of 0.9.71 does, and handle only
 * `session_joined` and `presence_update`, so they also show that an older client converges on the latest presence.
 */

const fixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "intercom-presence-fanout-")));
fixture.overrideAgentDir();
const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");

const BROKER_STARTUP_TIMEOUT_MS = 30_000;
const FANOUT_TEST_TIMEOUT_MS = 180_000;
const CONVERGENCE_TIMEOUT_MS = 60_000;
/** The scale of #3931's pooled fan-out, where the quadratic fan-out was measured. */
const SESSIONS = 150;
/** Identity syncs per session in a burst: one per Intercom tool call, each changing nothing but its activity time. */
const IDENTITY_SYNCS_PER_SESSION = 6;
/** Status changes per session in a burst, written back to back. */
const STATUS_CHANGES_PER_SESSION = 6;
/** Sessions that join while the group's sessions change their presence. */
const JOINERS = 10;
/**
 * At most two `presence_update` frames reach each recipient per peer for one burst: the burst may straddle one
 * coalescing interval. Before #5146 every change reached every peer, 12 frames per peer: 268,200 frames and about
 * 98 MB for 150 sessions.
 */
const PRESENCE_FRAME_BOUND = 2 * SESSIONS * (SESSIONS - 1);
/** The bytes those frames may take: a `presence_update` here is under 400 bytes. */
const PRESENCE_BYTE_BOUND = PRESENCE_FRAME_BOUND * 400;

interface Peer {
	readonly id: string;
	readonly socket: net.Socket;
	/** The latest status this session has been told of, by peer id. */
	readonly statuses: Map<string, string | undefined>;
	readonly counts: { presenceFrames: number; presenceBytes: number };
	request(frame: Record<string, unknown>, replyType: string): Promise<Record<string, unknown>>;
}

const peers: Peer[] = [];

/** One session that speaks the 0.9.71 wire: no protocol range, and only joins and presence updates handled. */
function connectPeer(name: string, group: string, status: string): Promise<Peer> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(getBrokerSocketPath());
		const statuses = new Map<string, string | undefined>();
		const counts = { presenceFrames: 0, presenceBytes: 0 };
		const waiting = new Map<string, (frame: Record<string, unknown>) => void>();
		let id: string | undefined;
		socket.on("error", reject);
		socket.on(
			"data",
			createMessageReader((frame) => {
				if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
				const message = frame as Record<string, unknown>;
				const session = message.session as { id: string; status?: string } | undefined;
				if (message.type === "presence_update" && session !== undefined) {
					counts.presenceFrames++;
					counts.presenceBytes += Buffer.byteLength(JSON.stringify(message));
				}
				if ((message.type === "presence_update" || message.type === "session_joined") && session !== undefined) {
					statuses.set(session.id, session.status);
				} else if (message.type === "session_left") {
					statuses.delete(message.sessionId as string);
				} else if (message.type === "registered") {
					id = message.sessionId as string;
					resolve(peer());
				} else if (message.type === "sessions") {
					// A list is the broker's view when it answers: it supersedes every frame before it, not those after.
					for (const listed of message.sessions as Array<{ id: string; status?: string }>) {
						if (listed.id !== id) statuses.set(listed.id, listed.status);
					}
				}
				if (typeof message.requestId === "string") {
					waiting.get(`${message.type}:${message.requestId}`)?.(message);
				}
			}, reject),
		);
		const peer = (): Peer => ({
			id: id!,
			socket,
			statuses,
			counts,
			request(frame, replyType) {
				const requestId = randomUUID();
				return new Promise((answer) => {
					waiting.set(`${replyType}:${requestId}`, answer);
					writeMessage(socket, { ...frame, requestId });
				});
			},
		});
		socket.once("connect", () => {
			const now = Date.now();
			writeMessage(socket, {
				type: "register",
				session: {
					name,
					cwd: fixture.agentDir,
					model: "test",
					pid: process.pid,
					startedAt: now,
					lastActivity: now,
					group,
					status,
				},
			});
		});
	});
}

/** The sessions of `group` a `list` shows to `peer`, by id, with their status. */
async function listedStatuses(peer: Peer, group: string): Promise<Map<string, string | undefined>> {
	const reply = await peer.request({ type: "list", group }, "sessions");
	const sessions = reply.sessions as Array<{ id: string; status?: string }>;
	return new Map(sessions.map((session) => [session.id, session.status]));
}

/** Resolves once every peer has been told `expected` for every other peer, or fails with the first mismatch. */
async function converged(members: readonly Peer[], expected: (peer: Peer) => string): Promise<void> {
	const deadline = performance.now() + CONVERGENCE_TIMEOUT_MS;
	for (;;) {
		let mismatch: string | undefined;
		for (const observer of members) {
			for (const peer of members) {
				if (peer === observer) continue;
				const seen = observer.statuses.get(peer.id);
				if (seen !== expected(peer)) {
					mismatch = `${observer.id} saw ${peer.id} as ${String(seen)}, not ${expected(peer)}`;
					break;
				}
			}
			if (mismatch !== undefined) break;
		}
		if (mismatch === undefined) return;
		if (performance.now() > deadline) assert.fail(`presence did not converge: ${mismatch}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}

function resetCounts(members: readonly Peer[]): void {
	for (const peer of members) {
		peer.counts.presenceFrames = 0;
		peer.counts.presenceBytes = 0;
	}
}

function totals(members: readonly Peer[]): { frames: number; bytes: number } {
	return members.reduce(
		(sum, peer) => ({
			frames: sum.frames + peer.counts.presenceFrames,
			bytes: sum.bytes + peer.counts.presenceBytes,
		}),
		{ frames: 0, bytes: 0 },
	);
}

beforeAll(async () => {
	await fixture.startSourceBroker(BROKER_STARTUP_TIMEOUT_MS);
}, BROKER_STARTUP_TIMEOUT_MS * 2);

afterAll(async () => {
	for (const peer of peers.splice(0)) peer.socket.destroy();
	await fixture.cleanup();
});

test(
	"a burst of presence changes from 150 sessions reaches each peer within a bounded number of frames and converges (#5146)",
	async () => {
		const group = `presence-${randomUUID()}`;
		const members: Peer[] = [];
		for (let index = 0; index < SESSIONS; index++) {
			const peer = await connectPeer(`member-${index}`, group, "starting");
			peers.push(peer);
			members.push(peer);
		}
		// A session learns those that joined before it from a list, and those after it from their joins.
		await Promise.all(members.map((peer) => listedStatuses(peer, group)));
		await converged(members, () => "starting");
		resetCounts(members);

		for (const peer of members) {
			for (let sync = 0; sync < IDENTITY_SYNCS_PER_SESSION; sync++) {
				writeMessage(peer.socket, {
					type: "presence",
					name: `member-${members.indexOf(peer)}`,
					model: "test",
					status: "starting",
					groups: [group],
				});
			}
			for (let change = 1; change <= STATUS_CHANGES_PER_SESSION; change++) {
				writeMessage(peer.socket, { type: "presence", status: `${peer.id}:${change}` });
			}
		}
		const final = (peer: Peer) => `${peer.id}:${STATUS_CHANGES_PER_SESSION}`;
		await converged(members, final);
		// Let any frame still in flight arrive before counting.
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
		const burst = totals(members);
		console.log(`[presence-fanout #5146] ${JSON.stringify({ sessions: SESSIONS, ...burst })}`);
		assert.ok(burst.frames <= PRESENCE_FRAME_BOUND, `${burst.frames} presence frames exceed ${PRESENCE_FRAME_BOUND}`);
		assert.ok(burst.bytes <= PRESENCE_BYTE_BOUND, `${burst.bytes} presence bytes exceed ${PRESENCE_BYTE_BOUND}`);

		// Sessions joining during a second burst learn every member's latest presence from a list and the updates after it.
		const joiners = await Promise.all(
			Array.from({ length: JOINERS }, (_, index) => connectPeer(`joiner-${index}`, group, "joined")),
		);
		peers.push(...joiners);
		for (const peer of members) writeMessage(peer.socket, { type: "presence", status: `${peer.id}:again` });
		await Promise.all(joiners.map((joiner) => listedStatuses(joiner, group)));
		const everyone = [...members, ...joiners];
		await converged(everyone, (peer) => (joiners.includes(peer) ? "joined" : `${peer.id}:again`));
		const listed = await listedStatuses(joiners[0]!, group);
		for (const peer of everyone) {
			assert.equal(
				listed.get(peer.id),
				joiners.includes(peer) ? "joined" : `${peer.id}:again`,
				"a list shows the latest presence",
			);
		}
	},
	FANOUT_TEST_TIMEOUT_MS,
);
