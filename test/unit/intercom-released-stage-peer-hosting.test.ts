import assert from "node:assert/strict";
import { IntercomBrokerProtocolError } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import { IntercomClient, type SendOptions } from "../../packages/intercom/broker/client.js";
import { HOSTED_SESSION_FRAME_MAX } from "../../packages/intercom/broker/hosted-sessions.js";
import {
	isRetryableHostingFailure,
	RELEASED_STAGE_RECONNECT_ATTEMPTS_MAX,
	type ReleasedStageAnnouncement,
	ReleasedStagePeers,
	type ReleasedStageReconnectFailure,
} from "../../packages/intercom/released-stage-peers.js";
import type {
	HostedSessionAssignment,
	HostedSessionFrameItem,
	Message,
	SessionInfo,
} from "../../packages/intercom/types.js";

/** The first reconnect delay of `reconnectDelayMs`; later attempts wait 2 s, then 5 s. */
const FIRST_RETRY_MS = 1_000;

interface FakeConnection {
	readonly client: IntercomClient;
	readonly hosted: HostedSessionFrameItem[][];
	readonly unhosted: string[][];
	readonly sent: { readonly to: string; readonly options: SendOptions }[];
	readonly registration: Record<string, string | number | string[]>[];
	disconnects: number;
}

interface HarnessOptions {
	/** Answers the `call`-th `hostSessions` across every connection; the default assigns an id per connection. */
	readonly host?: (
		frame: readonly HostedSessionFrameItem[],
		connection: number,
		call: number,
	) => Promise<HostedSessionAssignment[]>;
	/** Opens the `index`-th connection; the default opens at once. */
	readonly connect?: (index: number) => Promise<void>;
	readonly prepare?: () => Promise<void>;
	readonly report?: (failure: ReleasedStageReconnectFailure) => void;
}

const route = (index: number, overrides: Partial<ReleasedStageAnnouncement> = {}): ReleasedStageAnnouncement => ({
	runId: "run-4642",
	stageId: `stage-${index}`,
	stageName: `review-${index}`,
	sessionId: `stage-session-${index}`,
	group: "workflow:run-4642",
	answer: async (content) => `answer to ${content.split("\n")[2]}`,
	...overrides,
});

const assignEach = (frame: readonly HostedSessionFrameItem[], connection: number): HostedSessionAssignment[] =>
	frame.map((item) => ({ key: item.key, sessionId: `c${connection}:${item.key}` }));

/** The broker id connection `connection` gives stage `index`. */
const idOf = (index: number, connection = 0): string => `c${connection}:run-4642\0stage-${index}`;

function harness(options: HarnessOptions = {}) {
	const connections: FakeConnection[] = [];
	const relayed: { readonly text: string; readonly channel?: string }[] = [];
	let hostCalls = 0;
	const peers = new ReleasedStagePeers({
		...(options.report === undefined ? {} : { report: options.report }),
		prepare: options.prepare ?? (async () => {}),
		cwd: () => "/workspace",
		relay: (_from, message, channel) => relayed.push({ text: message.content.text, ...(channel ? { channel } : {}) }),
		createClient: (returnAddress) => {
			const index = connections.length;
			const client = new IntercomClient(returnAddress);
			const connection: FakeConnection = {
				client,
				hosted: [],
				unhosted: [],
				sent: [],
				registration: [],
				disconnects: 0,
			};
			connections.push(connection);
			vi.spyOn(client, "connect").mockImplementation(async (registration, ...rest) => {
				connection.registration.push({
					...(registration as unknown as Record<string, string | number | string[]>),
					registrationGroup: String(rest[3]),
				});
				await options.connect?.(index);
			});
			vi.spyOn(client, "hostSessions").mockImplementation(async (frame) => {
				connection.hosted.push([...frame]);
				const call = hostCalls++;
				return options.host === undefined ? assignEach(frame, index) : options.host(frame, index, call);
			});
			vi.spyOn(client, "unhostSessions").mockImplementation(async (ids) => {
				connection.unhosted.push([...ids]);
			});
			vi.spyOn(client, "send").mockImplementation(async (to, sendOptions) => {
				connection.sent.push({ to, options: sendOptions });
				return { id: "reply", delivered: true };
			});
			vi.spyOn(client, "disconnect").mockImplementation(async () => {
				connection.disconnects += 1;
			});
			return client;
		},
	});
	return { peers, connections, relayed };
}

const asker: SessionInfo = { id: "asker", name: "asker", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

function deliver(
	connection: FakeConnection,
	recipient: string,
	text: string,
	options: { readonly id?: string; readonly expectsReply?: boolean; readonly channel?: "supervisor" } = {},
): void {
	const message: Message = {
		id: options.id ?? text,
		timestamp: 1,
		expectsReply: options.expectsReply ?? true,
		content: { text },
	};
	connection.client.emit("hosted_message", recipient, asker, message, options.channel);
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a released stage hosted on the shared connection answers asks as itself (#4642)", () => {
	test("an ask is answered as the stage it names; other messages go to the host session, unknown ones nowhere (#4642)", async () => {
		const { peers, connections, relayed } = harness();
		await peers.adopt(route(0));
		await peers.adopt(route(1));
		const [connection] = connections;

		deliver(connection!, idOf(1), "which file?", { id: "q1" });
		deliver(connection!, idOf(0), "fyi", { expectsReply: false });
		deliver(connection!, idOf(0), "to the owner", { channel: "supervisor" });
		deliver(connection!, "c0:unknown", "lost", { expectsReply: false });
		deliver(connection!, "c0:unknown", "lost ask");
		await settle();

		assert.deepEqual(connection!.sent, [
			{
				to: "asker",
				options: { text: "answer to which file?", replyTo: "q1", requirePendingReply: true, hostedSender: idOf(1) },
			},
		]);
		assert.deepEqual(relayed, [{ text: "fyi" }, { text: "to the owner", channel: "supervisor" }]);
		await peers.disconnectAll();
	});

	test("an ask delivered again while it is answered is answered once, and again once that answer is done (#4642)", async () => {
		let release: () => void = () => {};
		let answers = 0;
		const { peers, connections } = harness();
		await peers.adopt(
			route(0, {
				answer: async () => {
					answers += 1;
					if (answers === 1) await new Promise<void>((resolve) => (release = resolve));
					return "answer";
				},
			}),
		);
		const [connection] = connections;

		deliver(connection!, idOf(0), "q", { id: "q1" });
		deliver(connection!, idOf(0), "q", { id: "q1" });
		await settle();
		release();
		await settle();
		assert.equal(answers, 1);
		assert.equal(connection!.sent.length, 1);

		deliver(connection!, idOf(0), "q", { id: "q1" });
		await settle();
		assert.equal(answers, 2, "a finished ask is no longer remembered");
		await peers.disconnectAll();
	});

	test("an answer that finishes after its stage was replaced, or after the peers were disconnected, is not sent (#4642)", async () => {
		for (const interrupt of ["replace", "disconnect"] as const) {
			let release: () => void = () => {};
			const { peers, connections } = harness();
			await peers.adopt(route(0, { answer: () => new Promise((resolve) => (release = () => resolve("late"))) }));
			const [connection] = connections;
			deliver(connection!, idOf(0), "q", { id: "q1" });
			await settle();

			if (interrupt === "replace") await peers.adopt(route(0, { group: "workflow:elsewhere" }));
			else await peers.disconnectAll();
			release();
			await settle();

			assert.deepEqual(connection!.sent, [], interrupt);
			await peers.disconnectAll();
		}
	});
});

describe("a message that arrives with the answer naming its stage (#4642)", () => {
	test("is delivered to the stage once its id is known, and one for a session never hosted is still dropped", async () => {
		const answered = Promise.withResolvers<HostedSessionAssignment[]>();
		const { peers, connections, relayed } = harness({ host: () => answered.promise });
		const adopting = peers.adopt(route(0));
		await settle();
		const [connection] = connections;

		deliver(connection!, idOf(0), "early fyi", { expectsReply: false });
		deliver(connection!, "c0:unknown", "lost", { expectsReply: false });
		await settle();
		assert.equal(relayed.length, 0, "nothing is delivered before the stage's id is known");

		answered.resolve(assignEach(connection!.hosted[0]!, 0));
		await adopting;
		await settle();

		assert.deepEqual(
			relayed.map((message) => message.text),
			["early fyi"],
		);
	});
});

describe("an ask in the read that carries the hosting answer (#4642)", () => {
	test("is answered by the stage, as the client emits it in the turn that resolves the request", async () => {
		const answered = Promise.withResolvers<HostedSessionAssignment[]>();
		const { peers, connections } = harness({ host: () => answered.promise });
		const adopting = peers.adopt(route(0));
		await settle();
		const [connection] = connections;

		answered.resolve(assignEach(connection!.hosted[0]!, 0));
		deliver(connection!, idOf(0), "asked at once", { id: "same-read" });
		await adopting;
		await settle();

		assert.equal(connection!.sent.length, 1, "the ask was answered, not dropped");
		assert.equal(connection!.sent[0]!.to, "asker");
		assert.equal(connection!.sent[0]!.options.replyTo, "same-read");
		assert.equal(connection!.sent[0]!.options.hostedSender, idOf(0));
	});
});

describe("adopting a stage again (#4642)", () => {
	test("a changed model, live-route capability or stage keys hosts the stage again; the same route does not (#4642)", async () => {
		const live = { stageKeys: ["stage-0", "review-0"], capability: "cap" };
		const { peers, connections } = harness();
		await peers.adopt(route(0, { liveRoute: live }));
		await peers.adopt(route(0, { liveRoute: { ...live, stageKeys: [...live.stageKeys] } }));
		assert.equal(connections[0]!.hosted.length, 1, "the same two-key route registers nothing");

		// Each one changes a single field of the registration before it.
		for (const changed of [
			route(0, { liveRoute: live, model: "other/model" }),
			route(0, { liveRoute: { ...live, capability: "other" }, model: "other/model" }),
			route(0, { liveRoute: { stageKeys: ["stage-0"], capability: "other" }, model: "other/model" }),
		]) {
			const before: number = connections[0]!.hosted.length;
			await peers.adopt(changed);
			assert.equal(connections[0]!.hosted.length, before + 1, JSON.stringify(changed.liveRoute));
		}
		assert.equal(connections[0]!.unhosted.length, 3);
		await peers.disconnectAll();
	});

	test("a live route without stage keys is left out of the hosted session (#4642)", async () => {
		const { peers, connections } = harness();
		await peers.adopt(route(0, { liveRoute: { stageKeys: [], capability: "cap" } }));
		assert.equal(Object.hasOwn(connections[0]!.hosted[0]![0]!, "liveRoute"), false);
		await peers.disconnectAll();
	});

	test("a stage replaced while its connection is down is not removed through that connection (#4642)", async () => {
		vi.useFakeTimers();
		const { peers, connections } = harness();
		await peers.adopt(route(0));
		connections[0]!.client.emit("disconnected");

		const replacing = peers.adopt(route(0, { group: "workflow:elsewhere" }));
		await vi.advanceTimersByTimeAsync(0);
		await replacing;

		assert.deepEqual(connections[0]!.unhosted, []);
		assert.equal(connections.length, 2, "the replacement is hosted on a new connection");
		assert.equal(connections[1]!.hosted.length, 1);
		await peers.disconnectAll();
	});
});

describe("broker answers the peers do not expect (#4642)", () => {
	test("an ack naming an unknown stage is ignored, and a stage the ack left out is never removed by id (#4642)", async () => {
		const { peers, connections } = harness({
			host: async (frame, connection) => [
				{ key: "run-4642\0nobody", sessionId: "c0:nobody" },
				...assignEach(frame, connection).filter((item) => !item.key.endsWith("stage-1")),
			],
		});
		await peers.adopt(route(0));
		await peers.adopt(route(1));

		await peers.adopt(route(1, { group: "workflow:elsewhere" }));
		assert.deepEqual(connections[0]!.unhosted, [], "the stage had no broker id to remove");
		deliver(connections[0]!, idOf(0), "still here?", { id: "q" });
		await settle();
		assert.equal(connections[0]!.sent.length, 1);
		await peers.disconnectAll();
	});

	test("a hosting the broker refused is tried again on the same connection by the reconnect timer (#4642)", async () => {
		vi.useFakeTimers();
		const refusal = new Error("broker busy");
		const { peers, connections } = harness({
			host: async (frame, connection, call) => {
				if (call === 1) throw refusal;
				return assignEach(frame, connection);
			},
		});
		await peers.adopt(route(0));
		await assert.rejects(peers.adopt(route(1)), (error: Error) => error === refusal);
		assert.equal(vi.getTimerCount(), 1);

		await peers.adopt(route(0));
		assert.equal(connections[0]!.hosted.length, 2, "re-adopting a hosted stage hosts no other stage early");

		await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
		assert.deepEqual(
			connections[0]!.hosted.map((frame) => frame.map((item) => item.key)),
			[["run-4642\0stage-0"], ["run-4642\0stage-1"], ["run-4642\0stage-1"]],
		);
		assert.equal(connections.length, 1);
		deliver(connections[0]!, idOf(1), "now?", { id: "q" });
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(connections[0]!.sent.length, 1);
		await peers.disconnectAll();
	});

	test("a reconnect whose second frame fails is retried until every stage is hosted (#4642)", async () => {
		vi.useFakeTimers();
		let failedOnce = false;
		const { peers, connections } = harness({
			connect: async (index) => {
				if (index === 0) throw new Error("broker down");
			},
			host: async (frame, connection) => {
				if (frame.length === 1 && !failedOnce) {
					failedOnce = true;
					throw new Error("broker busy");
				}
				return assignEach(frame, connection);
			},
		});
		const count = HOSTED_SESSION_FRAME_MAX + 1;
		await Promise.allSettled(Array.from({ length: count }, (_, index) => peers.adopt(route(index))));

		await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
		assert.equal(vi.getTimerCount(), 1, "the failed frame scheduled another attempt");
		await vi.advanceTimersByTimeAsync(2_000);

		assert.deepEqual(
			connections[1]!.hosted.map((frame) => frame.length),
			[HOSTED_SESSION_FRAME_MAX, 1, 1],
		);
		assert.equal(vi.getTimerCount(), 0);
		await peers.disconnectAll();
	});

	test("exactly one frame's worth of stages is hosted in one frame (#4642)", async () => {
		const { peers, connections } = harness();
		await Promise.all(Array.from({ length: HOSTED_SESSION_FRAME_MAX }, (_, index) => peers.adopt(route(index))));
		assert.deepEqual(
			connections[0]!.hosted.map((frame) => frame.length),
			[HOSTED_SESSION_FRAME_MAX],
		);
		await peers.disconnectAll();
	});

	test("a closed connection's late ack or refusal leaves the stage as the next connection hosted it (#4642)", async () => {
		vi.useFakeTimers();
		for (const late of ["ack", "refusal"] as const) {
			let settleFirst: (assigned: HostedSessionAssignment[] | Error) => void = () => {};
			const { peers, connections } = harness({
				host: (frame, connection) =>
					connection === 0
						? new Promise((resolve, reject) => {
								settleFirst = (assigned) => (assigned instanceof Error ? reject(assigned) : resolve(assigned));
							})
						: Promise.resolve(assignEach(frame, connection)),
			});
			const adopting = peers.adopt(route(0));
			await vi.advanceTimersByTimeAsync(0);
			connections[0]!.client.emit("disconnected");
			await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
			assert.equal(connections[1]!.hosted.length, 1, late);

			settleFirst(late === "ack" ? assignEach(connections[0]!.hosted[0]!, 0) : new Error("closed"));
			await Promise.allSettled([adopting]);
			await vi.advanceTimersByTimeAsync(0);

			deliver(connections[1]!, idOf(0, 1), "here?", { id: "q" });
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(connections[1]!.sent.length, 1, `${late}: the stage still answers on the new connection`);
			await peers.adopt(route(0));
			assert.equal(connections[1]!.hosted.length, 1, `${late}: and is not hosted twice`);
			await peers.disconnectAll();
		}
	});
});

describe("the shared connection (#4642)", () => {
	test("it registers as a control session in a group of its own (#4642)", async () => {
		const { peers, connections } = harness();
		await peers.adopt(route(0));
		const [registration] = connections[0]!.registration;
		const { startedAt, lastActivity, pid, groups, group, registrationGroup, ...rest } = registration!;
		assert.deepEqual(rest, { cwd: "/workspace", model: "unknown", recipientPurpose: "control" });
		assert.equal(pid, process.pid);
		assert.equal(typeof startedAt, "number");
		assert.equal(lastActivity, startedAt);
		assert.match(String(group), /^released-stages:/);
		assert.deepEqual(groups, [group]);
		assert.equal(registrationGroup, group);
		await peers.disconnectAll();
	});

	test("events a closed connection still emits change nothing (#4642)", async () => {
		vi.useFakeTimers();
		const { peers, connections, relayed } = harness();
		await peers.adopt(route(0));
		const first = connections[0]!;
		first.client.emit("disconnected");
		deliver(first, idOf(0), "late", { expectsReply: false });
		await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
		assert.equal(connections.length, 2);

		first.client.emit("disconnected");
		assert.equal(vi.getTimerCount(), 0, "the closed connection's disconnect schedules nothing");
		await peers.adopt(route(1));
		assert.equal(connections.length, 2, "the current connection is still used");
		assert.deepEqual(relayed, []);
		await peers.disconnectAll();
	});

	test("reconnects back off one step per failed attempt (#4642)", async () => {
		vi.useFakeTimers();
		const { peers, connections } = harness({
			connect: async () => {
				throw new Error("broker down");
			},
		});
		await assert.rejects(peers.adopt(route(0)));
		await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS - 1);
		assert.equal(connections.length, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(connections.length, 2);
		await vi.advanceTimersByTimeAsync(2_000 - 1);
		assert.equal(connections.length, 2, "the second retry waits the second step");
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(connections.length, 3);
		await peers.disconnectAll();
	});

	test("a failure that says it cannot succeed is surfaced once, not retried, and a later adoption tries again (#4642)", async () => {
		vi.useFakeTimers();
		const refusal = new IntercomBrokerProtocolError({
			feature: "host_sessions",
			brokerProtocolMin: 1,
			brokerProtocolMax: 2,
			requiredProtocol: 3,
		});
		let refuse = true;
		const reported: ReleasedStageReconnectFailure[] = [];
		const { peers, connections } = harness({
			report: (failure) => reported.push(failure),
			host: async (frame, connection) => {
				if (refuse) throw refusal;
				return assignEach(frame, connection);
			},
		});

		await assert.rejects(peers.adopt(route(0)), (error: Error) => error === refusal);
		assert.equal(vi.getTimerCount(), 0, "no background retry is scheduled");
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		assert.equal(connections.length, 1, "nothing reconnected");
		assert.deepEqual(reported, [], "the caller got the failure; the background loop had none to report");

		refuse = false;
		await peers.adopt(route(0));
		assert.equal(connections[0]!.hosted.length, 2, "the next adoption hosts the stage again");
		await peers.disconnectAll();
	});

	test("only an error that does not say it is final is retried (#4642)", () => {
		assert.equal(isRetryableHostingFailure(new Error("broker down")), true);
		assert.equal(isRetryableHostingFailure(Object.assign(new Error("timed out"), { retryable: true })), true);
		assert.equal(isRetryableHostingFailure(Object.assign(new Error("refused"), { retryable: false })), false);
	});

	test("the background reconnect reports every failure and stops after its bound, until the next adoption (#4642)", async () => {
		vi.useFakeTimers();
		const reported: ReleasedStageReconnectFailure[] = [];
		const { peers, connections } = harness({
			report: (failure) => reported.push(failure),
			connect: async () => {
				throw new Error("broker down");
			},
		});
		await assert.rejects(peers.adopt(route(0)));
		await vi.advanceTimersByTimeAsync(60 * 60_000);

		assert.equal(connections.length, 1 + RELEASED_STAGE_RECONNECT_ATTEMPTS_MAX, "the first attempt and every retry");
		assert.equal(reported.length, RELEASED_STAGE_RECONNECT_ATTEMPTS_MAX);
		assert.deepEqual(
			reported.map((failure) => failure.attempt),
			Array.from({ length: RELEASED_STAGE_RECONNECT_ATTEMPTS_MAX }, (_, index) => index + 1),
		);
		assert.ok(reported.slice(0, -1).every((failure) => failure.retrying));
		assert.equal(reported.at(-1)!.retrying, false, "the last failure says nobody retries");
		assert.equal(reported.at(-1)!.peers, 1);
		assert.equal(reported.at(-1)!.error.message, "broker down");
		assert.equal(vi.getTimerCount(), 0);

		await assert.rejects(peers.adopt(route(1)));
		await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
		assert.equal(
			connections.length,
			2 + RELEASED_STAGE_RECONNECT_ATTEMPTS_MAX + 1,
			"a new adoption starts the retries again",
		);
		await peers.disconnectAll();
	});

	test("disconnecting cancels the reconnect timer and waits for a connection still opening (#4642)", async () => {
		vi.useFakeTimers();
		const failing = harness({
			connect: async () => {
				throw new Error("broker down");
			},
		});
		await assert.rejects(failing.peers.adopt(route(0)));
		assert.equal(vi.getTimerCount(), 1);
		await failing.peers.disconnectAll();
		assert.equal(vi.getTimerCount(), 0);

		let open: () => void = () => {};
		const opening = harness({ connect: () => new Promise<void>((resolve) => (open = resolve)) });
		const adopting = opening.peers.adopt(route(0));
		await vi.advanceTimersByTimeAsync(0);
		let disconnected = false;
		const disconnecting = opening.peers.disconnectAll().then(() => {
			disconnected = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(disconnected, false, "the opening connection is awaited");
		open();
		await Promise.allSettled([adopting]);
		await disconnecting;
		assert.equal(opening.connections[0]!.disconnects, 1);
	});

	test("disconnecting while the broker is being prepared opens no connection (#4642)", async () => {
		let prepared: () => void = () => {};
		const { peers, connections } = harness({ prepare: () => new Promise<void>((resolve) => (prepared = resolve)) });
		const adopting = peers.adopt(route(0));
		await settle();
		const disconnecting = peers.disconnectAll();
		prepared();
		await assert.rejects(adopting);
		await disconnecting;
		assert.equal(connections.length, 0);
	});
});
