import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import {
	ReleasedChildReservationError,
	UnknownReleasedChildError,
} from "../../packages/intercom/broker/released-child-errors.js";
import { RELEASED_CHILD_FRAME_MAX } from "../../packages/intercom/broker/released-children.js";

interface WrittenFrame {
	readonly type: string;
	readonly requestId: string;
	readonly [key: string]: unknown;
}

interface Internals {
	_sessionId: string;
	socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
	pendingRestoringRecipientRequests: Map<string, unknown>;
	handleBrokerMessage(message: unknown): void;
}

function decode(data: Buffer): WrittenFrame {
	return JSON.parse(data.subarray(4).toString("utf-8")) as WrittenFrame;
}

function connectedClient(onFrame?: (frame: WrittenFrame, internals: Internals) => void): {
	client: IntercomClient;
	internals: Internals;
	frames: WrittenFrame[];
} {
	const client = new IntercomClient();
	const internals = client as unknown as Internals;
	const frames: WrittenFrame[] = [];
	internals._sessionId = "owner";
	internals.socket = {
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(data) {
			const frame = decode(data);
			frames.push(frame);
			if (onFrame) queueMicrotask(() => onFrame(frame, internals));
			return true;
		},
	};
	return { client, internals, frames };
}

function ack(frame: WrittenFrame, internals: Internals): void {
	internals.handleBrokerMessage({ type: "released_children_ack", requestId: frame.requestId });
}

function names(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `child-${index}`);
}

describe("released-child client frames (#4326)", () => {
	test("reserving no children sends no frame (#4326)", async () => {
		const { client, frames } = connectedClient(ack);
		await client.reserveReleasedChildren([]);
		assert.equal(frames.length, 0);
	});

	test("reserving exactly 500 children sends a single frame (#4326)", async () => {
		const { client, frames } = connectedClient(ack);
		await client.reserveReleasedChildren(
			names(RELEASED_CHILD_FRAME_MAX).map((childName) => ({ childName, wake: true })),
		);
		assert.equal(frames.length, 1);
		assert.equal((frames[0].children as unknown[]).length, RELEASED_CHILD_FRAME_MAX);
	});

	test("reserving 501 children sends frames of 500 and 1 in order (#4326)", async () => {
		const { client, frames } = connectedClient(ack);
		await client.reserveReleasedChildren(names(501).map((childName) => ({ childName, wake: false })));
		assert.deepEqual(
			frames.map((frame) => [frame.type, (frame.children as { childName: string }[]).length]),
			[
				["reserve_released_children", 500],
				["reserve_released_children", 1],
			],
		);
		assert.deepEqual(frames[1]?.children, [{ childName: "child-500", wake: false }]);
	});

	test("reserve frames carry group and aliases only when given, with a copied alias list (#4326)", async () => {
		const { client, frames } = connectedClient(ack);
		const alias = "11111111-2222-4333-8444-555555555555";
		const aliases = [alias];
		await client.reserveReleasedChildren([
			{ childName: "plain", wake: true },
			{ childName: "full", group: "lane", aliases, wake: false },
		]);
		assert.deepEqual(frames[0]?.children, [
			{ childName: "plain", wake: true },
			{ childName: "full", group: "lane", aliases: [alias], wake: false },
		]);
		assert.deepEqual(Object.keys((frames[0].children as object[])[0] ?? {}), ["childName", "wake"]);
	});

	test("an invalid later frame fails the call before any frame is written (#4326)", async () => {
		const { client, frames } = connectedClient(ack);
		const children = [...names(500).map((childName) => ({ childName, wake: true })), { childName: "*", wake: true }];
		const error = await client.reserveReleasedChildren(children).then(
			() => undefined,
			(rejection: Error) => rejection,
		);
		assert.ok(error instanceof ReleasedChildReservationError);
		assert.equal(error.code, "invalid_child_name");
		assert.equal(frames.length, 0);
	});

	test("dropping no names sends no frame (#4326)", async () => {
		const { client, frames } = connectedClient(ack);
		await client.dropReleasedChildren([]);
		assert.equal(frames.length, 0);
	});

	test("dropping exactly 500 names sends one frame, and 1001 names send three (#4326)", async () => {
		const exact = connectedClient(ack);
		await exact.client.dropReleasedChildren(names(500));
		assert.equal(exact.frames.length, 1);

		const many = connectedClient(ack);
		const all = names(1001);
		await many.client.dropReleasedChildren(all);
		assert.deepEqual(
			many.frames.map((frame) => frame.childNames),
			[all.slice(0, 500), all.slice(500, 1000), all.slice(1000)],
		);
	});

	test("drop frames carry gone and refusal only when given (#4326)", async () => {
		const { client, frames } = connectedClient(ack);
		await client.dropReleasedChildren(["a"]);
		await client.dropReleasedChildren(["a"], { gone: "left" });
		await client.dropReleasedChildren(["a"], { refusal: "busy" });
		await client.dropReleasedChildren(["a"], { gone: "left", refusal: "busy" });
		const shaped = frames.map(({ requestId: _requestId, ...rest }) => rest);
		assert.deepEqual(shaped, [
			{ type: "drop_released_children", childNames: ["a"] },
			{ type: "drop_released_children", childNames: ["a"], gone: "left" },
			{ type: "drop_released_children", childNames: ["a"], refusal: "busy" },
			{ type: "drop_released_children", childNames: ["a"], gone: "left", refusal: "busy" },
		]);
	});

	test("acknowledging a wake writes the child name and resolves on the ack (#4326)", async () => {
		const { client, frames } = connectedClient(ack);
		await client.acknowledgeReleasedChildWake("worker");
		assert.equal(frames[0]?.type, "acknowledge_released_child_wake");
		assert.equal(frames[0]?.childName, "worker");
	});
});

describe("released_children_ack handling (#4326)", () => {
	test("a refusal rejects with the typed error carrying the child name (#4326)", async () => {
		const { client } = connectedClient((frame, internals) =>
			internals.handleBrokerMessage({
				type: "released_children_ack",
				requestId: frame.requestId,
				refusal: { code: "unknown_released_child", childName: "worker" },
			}),
		);
		const error = await client.acknowledgeReleasedChildWake("worker").then(
			() => undefined,
			(rejection: Error) => rejection,
		);
		assert.ok(error instanceof UnknownReleasedChildError);
		assert.equal(error.childName, "worker");
	});

	test("a refusal without a child name rejects without a childName (#4326)", async () => {
		const { client } = connectedClient((frame, internals) =>
			internals.handleBrokerMessage({
				type: "released_children_ack",
				requestId: frame.requestId,
				refusal: { code: "invalid_frame" },
			}),
		);
		const error = await client.dropReleasedChildren(["a"]).then(
			() => undefined,
			(rejection: Error) => rejection,
		);
		assert.ok(error instanceof ReleasedChildReservationError);
		assert.equal(error.code, "invalid_frame");
		assert.equal(error.childName, undefined);
	});

	test("a settled request is removed and an unknown request id is ignored (#4326)", async () => {
		const { client, internals } = connectedClient(ack);
		await client.acknowledgeReleasedChildWake("worker");
		assert.equal(internals.pendingRestoringRecipientRequests.size, 0);
		assert.doesNotThrow(() =>
			internals.handleBrokerMessage({ type: "released_children_ack", requestId: "never-sent" }),
		);
	});

	const malformed: [string, Record<string, unknown>][] = [
		["a missing request id", {}],
		["a numeric request id", { requestId: 4 }],
		["a string refusal", { requestId: "r", refusal: "nope" }],
		["a null refusal", { requestId: "r", refusal: null }],
		["an unknown refusal code", { requestId: "r", refusal: { code: "bogus" } }],
		["a non-string refusal code", { requestId: "r", refusal: { code: 5 } }],
		["a refusal without a code", { requestId: "r", refusal: {} }],
		["a non-string refusal child name", { requestId: "r", refusal: { code: "invalid_frame", childName: 5 } }],
	];
	for (const [label, fields] of malformed) {
		test(`${label} is rejected as an invalid message (#4326)`, () => {
			const { internals } = connectedClient();
			assert.throws(
				() => internals.handleBrokerMessage({ type: "released_children_ack", ...fields }),
				(error: Error) => error.message === "Invalid released_children_ack message",
			);
		});
	}

	for (const code of [
		"invalid_frame",
		"invalid_child_name",
		"invalid_alias",
		"too_many_aliases",
		"invalid_group",
		"unknown_released_child",
	]) {
		test(`the ${code} refusal code is parsed (#4326)`, async () => {
			const { client } = connectedClient((frame, internals) =>
				internals.handleBrokerMessage({
					type: "released_children_ack",
					requestId: frame.requestId,
					refusal: { code },
				}),
			);
			const error = await client.acknowledgeReleasedChildWake("w").then(
				() => undefined,
				(rejection: Error) => rejection,
			);
			assert.equal((error as ReleasedChildReservationError).code, code);
		});
	}
});

describe("delivery_failed reason codes (#4326)", () => {
	const base = { type: "delivery_failed", messageId: "m", reason: "gone" };

	test("known reason codes are accepted (#4326)", () => {
		const { internals } = connectedClient();
		for (const reasonCode of [
			"message_id_conflict",
			"session_not_found",
			"recipient_not_restored",
			"recipient_parked",
		]) {
			assert.doesNotThrow(() => internals.handleBrokerMessage({ ...base, reasonCode }), reasonCode);
		}
		assert.doesNotThrow(() => internals.handleBrokerMessage(base));
	});

	test("an unknown or non-string reason code is rejected (#4326)", () => {
		const { internals } = connectedClient();
		for (const reasonCode of ["unheard_of", "", 7, null]) {
			assert.throws(
				() => internals.handleBrokerMessage({ ...base, reasonCode }),
				(error: Error) => error.message === "Invalid delivery_failed message",
			);
		}
	});
});
