import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { ReturnPaths } from "../../packages/intercom/broker/return-paths.js";
import {
	type BrokerConnectedSession,
	createReturnPathAuthority,
	handleBrokerSend,
	type ReturnPathAuthority,
	returnPathParty,
} from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";

/** Sessions sharing the sender's group: every one of them is a visible candidate for a name. */
const CROWD_SIZE = 2_000;
/**
 * How often one direct send may read a session's id, per session the broker serves: a constant, so the send stays
 * linear in the sessions however many there are. A scan that compares every session with every visible one reads it
 * thousands of times per session.
 */
const ID_READS_PER_SESSION = 10;
/**
 * How many times one direct send may ask about return paths. It looks up the paths its sender holds once; it never
 * asks about each session the broker serves.
 */
const RETURN_PATH_LOOKUPS_PER_SEND = 1;

const reads = { id: 0 };

/** A session whose id reads are counted. */
function session(id: string, group: string, socket: net.Socket): BrokerConnectedSession {
	const info = { id, name: id, group, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
	return {
		socket,
		info: new Proxy(info, {
			get(target, property, receiver) {
				if (property === "id") reads.id += 1;
				return Reflect.get(target, property, receiver);
			},
		}),
		registrationGroup: group,
		registrationReturnAddress: `host:${id}`,
	};
}

test("a direct send stays linear in the sessions the broker serves and asks about return paths once", () => {
	const sessions = new Map<string, BrokerConnectedSession>();
	const sockets = new Map<net.Socket, string>();
	const socketFor = (id: string): net.Socket => {
		const socket = {} as net.Socket;
		sockets.set(socket, id);
		return socket;
	};
	const stage = session("stage", "crowd", socketFor("stage"));
	const launcher = session("launcher", "default", socketFor("launcher"));
	sessions.set(stage.info.id, stage);
	sessions.set(launcher.info.id, launcher);
	for (let index = 0; index < CROWD_SIZE; index++) {
		const peer = session(`peer-${index}`, "crowd", socketFor(`peer-${index}`));
		sessions.set(peer.info.id, peer);
	}
	const paths = new ReturnPaths();
	paths.open(returnPathParty(stage), returnPathParty(launcher), "launcher-note");
	const lookups = { holds: 0, answerable: 0 };
	const real = createReturnPathAuthority(paths, sessions);
	const authority: ReturnPathAuthority = {
		...real,
		holds: (sender, target) => {
			lookups.holds += 1;
			return real.holds(sender, target);
		},
		answerable: (sender) => {
			lookups.answerable += 1;
			return real.answerable(sender);
		},
	};
	const written: Array<{ to: string | undefined; frame: BrokerMessage }> = [];
	reads.id = 0;
	handleBrokerSend(
		stage.socket,
		{ type: "send", to: "launcher", message: { id: "answer", timestamp: 1, content: { text: "on it" } } },
		stage.info.id,
		sessions,
		new DeliveredMessageCache(),
		(socket, frame) => {
			written.push({ to: sockets.get(socket), frame });
			return true;
		},
		new SupervisorChannelCache(),
		new PendingQuestionIndex(),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		authority,
	);
	assert.deepEqual(
		written.map(({ to, frame }) => [to, frame.type]),
		[
			["launcher", "message"],
			["stage", "delivered"],
		],
	);
	assert.ok(lookups.holds + lookups.answerable <= RETURN_PATH_LOOKUPS_PER_SEND, JSON.stringify(lookups));
	assert.ok(reads.id <= sessions.size * ID_READS_PER_SESSION, `${reads.id} id reads for ${sessions.size} sessions`);
});
