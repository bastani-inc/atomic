import assert from "node:assert/strict";
import type net from "node:net";
import { join } from "node:path";
import { describe, test } from "vitest";
import * as currentPaths from "../../packages/intercom/broker/paths.js";
import {
	agreedProtocol,
	BROKER_PROTOCOL,
	type BrokerProtocolRange,
	decideBrokerProtocol,
	HOSTED_SESSIONS_PROTOCOL,
	isBrokerProtocolRange,
	LEGACY_BROKER_PROTOCOL,
	protocolRangeOf,
	VERIFIED_REGISTRATION_PROTOCOL,
} from "../../packages/intercom/broker/protocol-version.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import {
	clientHostsSessions,
	holdWrites,
	PROTOCOL_2_FRAME_TYPES,
	PROTOCOL_3_FRAME_TYPES,
	recordClientProtocol,
	releaseHeldWrites,
	writeMessageIfOpen,
	writeMessageWithOutcome,
} from "../../packages/intercom/broker/socket-writes.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const range = (min: number, max: number): BrokerProtocolRange => ({ min, max });

describe("deciding what to do with a running broker (#4538)", () => {
	test("this version speaks protocol 1, the 0.9.71 wire, through protocol 3, and a broker without a range is protocol 1 (#4642)", () => {
		assert.deepEqual(BROKER_PROTOCOL, range(1, 3));
		assert.deepEqual(LEGACY_BROKER_PROTOCOL, range(1, 1));
		assert.equal(VERIFIED_REGISTRATION_PROTOCOL, 2);
		assert.equal(HOSTED_SESSIONS_PROTOCOL, 3);
		assert.deepEqual(protocolRangeOf(undefined), LEGACY_BROKER_PROTOCOL);
		assert.deepEqual(protocolRangeOf(range(3, 5)), range(3, 5));
	});

	const cases: ReadonlyArray<readonly [string, BrokerProtocolRange, BrokerProtocolRange, string, number | undefined]> =
		[
			["an older broker whose versions this one accepts is upgraded", range(1, 2), range(1, 1), "upgrade", 1],
			["a broker of this version is kept", range(1, 2), range(1, 2), "compatible", 2],
			["a newer broker is never downgraded", range(1, 2), range(1, 3), "compatible", 2],
			[
				"a newer broker that dropped protocol 1 is kept and spoken to at 2",
				range(1, 2),
				range(2, 3),
				"compatible",
				2,
			],
			[
				"an older broker accepting a version this one dropped is kept, so none of its sessions break",
				range(2, 3),
				range(1, 2),
				"compatible",
				2,
			],
			["ranges that share no version leave the broker alone", range(3, 4), range(1, 2), "incompatible", undefined],
			[
				"a broker newer than every version this one speaks is left alone",
				range(1, 2),
				range(3, 4),
				"incompatible",
				undefined,
			],
			[
				"an older broker of two versions is upgraded by one that accepts both",
				range(1, 3),
				range(1, 2),
				"upgrade",
				2,
			],
		];
	for (const [label, own, running, decision, agreed] of cases) {
		test(label, () => {
			assert.equal(decideBrokerProtocol(own, running), decision);
			assert.equal(agreedProtocol(own, running), agreed);
		});
	}

	test("a protocol range on the wire is positive integers with min no greater than max", () => {
		assert.ok(isBrokerProtocolRange({ min: 1, max: 1 }));
		assert.ok(isBrokerProtocolRange({ min: 1, max: 2, extra: true }));
		for (const value of [
			undefined,
			null,
			2,
			"1-2",
			[1, 2],
			{ min: 2, max: 1 },
			{ min: 0, max: 1 },
			{ min: 1, max: 1.5 },
			{ min: "1", max: 2 },
			{ min: 1 },
			{ max: 2 },
			{ min: 1, max: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			assert.equal(isBrokerProtocolRange(value as never), false, JSON.stringify(value));
		}
	});
});

/** A socket double that records what is written to it; `destroyed`/`writableEnded` follow `writeMessageIfOpen`'s test. */
function recordingSocket(): { socket: net.Socket; frames: string[] } {
	const frames: string[] = [];
	const socket = {
		destroyed: false,
		writableEnded: false,
		write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
			frames.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			callback?.(null);
			return true;
		},
	} as unknown as net.Socket;
	return { socket, frames };
}

const PROTOCOL_2_FRAMES: readonly BrokerOutboundFrame[] = [
	{ type: "peer_rebound", replyTo: "q", previousSessionId: "a", sessionId: "b" },
	{
		type: "released_child_reply",
		childName: "worker",
		handoffId: "h",
		replyTo: "q",
		from: { id: "p", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
		message: { id: "m1", timestamp: 1, content: { text: "done" } },
	},
	{ type: "released_children_ack", requestId: "r" },
	{ type: "restoring_recipient_wake", childName: "worker" },
];

describe("frames a broker writes to a client of protocol 1 (#4538)", () => {
	test("the frames of protocol 2 are exactly those a 0.9.71 client does not handle", () => {
		assert.deepEqual([...PROTOCOL_2_FRAME_TYPES].sort(), [
			"peer_rebound",
			"released_child_reply",
			"released_children_ack",
			"restoring_recipient_wake",
		]);
		assert.deepEqual(
			PROTOCOL_2_FRAMES.map((frame) => frame.type),
			[...PROTOCOL_2_FRAME_TYPES],
		);
	});

	test("a client of protocol 1 is never written a frame of protocol 2, and the write reports it was not made", () => {
		const { socket, frames } = recordingSocket();
		recordClientProtocol(socket, LEGACY_BROKER_PROTOCOL);
		for (const frame of PROTOCOL_2_FRAMES) {
			assert.equal(writeMessageIfOpen(socket, frame), false, frame.type);
			const outcomes: boolean[] = [];
			writeMessageWithOutcome(socket, frame, (written) => outcomes.push(written));
			assert.deepEqual(outcomes, [false], frame.type);
		}
		assert.equal(writeMessageIfOpen(socket, { type: "delivered", messageId: "m1" }), true);
		assert.equal(frames.length, 1);
		assert.match(frames[0] ?? "", /"type":"delivered"/);
	});

	test("a client of protocol 1 is not handed a frame of protocol 2 through held writes either", () => {
		const { socket, frames } = recordingSocket();
		recordClientProtocol(socket, LEGACY_BROKER_PROTOCOL);
		holdWrites(socket);
		assert.equal(
			writeMessageIfOpen(socket, { type: "peer_rebound", replyTo: "q", previousSessionId: "a", sessionId: "b" }),
			false,
		);
		assert.equal(writeMessageIfOpen(socket, { type: "delivered", messageId: "m1" }), true);
		assert.deepEqual(
			releaseHeldWrites(socket).map((held) => held.message.type),
			["delivered"],
		);
		assert.equal(frames.length, 0);
	});

	test("a confirmed write to an open socket writes the frame and reports it written, and one to a closed socket does not", () => {
		const { socket, frames } = recordingSocket();
		recordClientProtocol(socket, range(1, 2));
		const outcomes: boolean[] = [];
		writeMessageWithOutcome(socket, { type: "delivered", messageId: "m1" }, (written) => outcomes.push(written));
		assert.deepEqual(outcomes, [true]);
		assert.equal(frames.length, 1);
		(socket as unknown as { destroyed: boolean }).destroyed = true;
		writeMessageWithOutcome(socket, { type: "delivered", messageId: "m2" }, (written) => outcomes.push(written));
		assert.equal(writeMessageIfOpen(socket, { type: "delivered", messageId: "m3" }), false);
		assert.deepEqual(outcomes, [true, false]);
		assert.equal(frames.length, 1);
	});

	test("a client of protocol 2, or one recorded again as protocol 2, receives every frame", () => {
		for (const record of [[range(1, 2)], [LEGACY_BROKER_PROTOCOL, range(1, 2)], [range(2, 7)]]) {
			const { socket, frames } = recordingSocket();
			for (const protocol of record) recordClientProtocol(socket, protocol);
			for (const frame of PROTOCOL_2_FRAMES) assert.equal(writeMessageIfOpen(socket, frame), true, frame.type);
			assert.equal(frames.length, PROTOCOL_2_FRAMES.length);
		}
	});

	test("only a client of protocol 3 hosts sessions and is written their answers (#4642)", () => {
		const ack: BrokerOutboundFrame = { type: "hosted_sessions_ack", requestId: "r1", sessions: [] };
		assert.deepEqual([...PROTOCOL_3_FRAME_TYPES], ["hosted_sessions_ack"]);
		for (const [protocol, hosts] of [
			[undefined, false],
			[LEGACY_BROKER_PROTOCOL, false],
			[range(1, 2), false],
			[range(1, 3), true],
			[range(3, 7), true],
		] as const) {
			const { socket, frames } = recordingSocket();
			if (protocol !== undefined) recordClientProtocol(socket, protocol);
			assert.equal(clientHostsSessions(socket), hosts, JSON.stringify(protocol));
			assert.equal(writeMessageIfOpen(socket, ack), hosts, JSON.stringify(protocol));
			assert.equal(frames.length, hosts ? 1 : 0);
		}
		const { socket } = recordingSocket();
		recordClientProtocol(socket, range(1, 3));
		recordClientProtocol(socket, range(1, 2));
		assert.equal(clientHostsSessions(socket), false, "a client recorded again at protocol 2 no longer hosts");
	});

	test("a socket no client protocol was recorded for keeps receiving every frame", () => {
		const { socket, frames } = recordingSocket();
		for (const frame of PROTOCOL_2_FRAMES) assert.equal(writeMessageIfOpen(socket, frame), true, frame.type);
		assert.equal(frames.length, PROTOCOL_2_FRAMES.length);
	});
});

interface BrokerPaths {
	getBrokerSocketPath(platform?: NodeJS.Platform, agentDir?: string): string;
	getBrokerSpawnLockPath(agentDir?: string): string;
	getBrokerPidPath(agentDir?: string): string;
}

describe("the broker's address across versions (#4538)", () => {
	test("this version's broker binds the named pipe and socket that 0.9.71 sessions reconnect to, and shares their spawn lock", async () => {
		const previousPaths = (await import(
			join(import.meta.dirname, "../fixtures/intercom-0.9.71/broker/paths.ts")
		)) as BrokerPaths;
		const current: BrokerPaths = currentPaths;
		const agentDirs = [
			"C:\\Users\\dev\\.atomic\\agent",
			"D:\\a b\\agent",
			"/home/dev/.atomic/agent",
			"/tmp/x y/agent",
		];
		for (const agentDir of agentDirs) {
			for (const platform of ["win32", "linux", "darwin"] as const) {
				assert.equal(
					current.getBrokerSocketPath(platform, agentDir),
					previousPaths.getBrokerSocketPath(platform, agentDir),
					`${platform} ${agentDir}`,
				);
			}
			assert.equal(current.getBrokerSpawnLockPath(agentDir), previousPaths.getBrokerSpawnLockPath(agentDir));
			assert.equal(current.getBrokerPidPath(agentDir), previousPaths.getBrokerPidPath(agentDir));
		}
		assert.match(current.getBrokerSocketPath("win32", agentDirs[0]), /^\\\\\.\\pipe\\/);
	});
});
