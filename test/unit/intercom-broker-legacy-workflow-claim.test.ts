/**
 * Atomic 0.10.0 removed workflows. A 0.9.x session may still send `claim_workflow_invocation` (a 0.9.x client sends it
 * only to a broker that advertises the claim, which this one no longer does, so the raw frame is driven here). The broker
 * answers it in place with `claimed: false`, a frame that client already handles, and keeps the connection serving.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const BROKER_START_TIMEOUT_MS = 30_000;
const FRAME_TIMEOUT_MS = 5_000;

const agentDir = mkdtempSync(join(tmpdir(), "intercom-legacy-claim-"));
const fixture = new IntercomBrokerFixture(agentDir);

type Frame = Record<string, unknown> & { readonly type: string };

/** A raw connection speaking the 0.9.x wire format, recording every frame and whether the broker closed it. */
async function connectRaw() {
	const socket = net.createConnection(getBrokerSocketPath(process.platform, agentDir));
	fixture.onCleanup(() => {
		socket.destroy();
	});
	const received: Frame[] = [];
	let closed = false;
	socket.on("error", () => {});
	socket.on("close", () => {
		closed = true;
	});
	socket.on(
		"data",
		createMessageReader(
			(frame) => received.push(frame as Frame),
			(error) => socket.destroy(error),
		),
	);
	await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
	const next = async (matches: (frame: Frame) => boolean): Promise<Frame> => {
		const deadline = performance.now() + FRAME_TIMEOUT_MS;
		for (;;) {
			const found = received.find(matches);
			if (found !== undefined) return found;
			if (closed) throw new Error(`the broker closed the connection; received ${JSON.stringify(received)}`);
			if (performance.now() > deadline) throw new Error(`no matching frame; received ${JSON.stringify(received)}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	return { socket, received, next, isClosed: () => closed };
}

beforeAll(async () => {
	fixture.overrideAgentDir();
	await fixture.startSourceBroker(BROKER_START_TIMEOUT_MS);
}, BROKER_START_TIMEOUT_MS + 5_000);

afterAll(async () => {
	await fixture.cleanup();
});

test("a 0.9.x session's raw claim_workflow_invocation is answered claimed:false on a connection that keeps serving", async () => {
	const runId = "0b7d2c1e-0000-4000-8000-000000000001";
	const group = `workflow:${runId}`;
	const raw = await connectRaw();
	const now = Date.now();
	writeMessage(raw.socket, {
		type: "register",
		session: {
			name: "legacy-launcher",
			cwd: "/repo",
			model: "faux",
			pid: 1,
			startedAt: now,
			lastActivity: now,
			group,
		},
		returnAddress: "legacy-launcher-address",
	});
	const registered = await raw.next((frame) => frame.type === "registered");
	assert.equal(registered.claimsWorkflowInvocations, undefined, "the broker no longer advertises the claim");

	writeMessage(raw.socket, { type: "claim_workflow_invocation", requestId: "claim-1", runId, capability: "launcher" });
	const claimed = await raw.next((frame) => frame.type === "workflow_invocation_claimed");
	assert.deepEqual(claimed, { type: "workflow_invocation_claimed", requestId: "claim-1", claimed: false });

	writeMessage(raw.socket, { type: "list", requestId: "after-claim" });
	const listed = await raw.next((frame) => frame.type === "sessions" && frame.requestId === "after-claim");
	assert.ok(
		Array.isArray(listed.sessions) &&
			listed.sessions.some((entry: { name?: string }) => entry.name === "legacy-launcher"),
		"the session is still registered and listed",
	);
	assert.equal(raw.isClosed(), false);
	assert.deepEqual(
		raw.received.filter((frame) => frame.type === "registration_failed" || frame.type === "error"),
		[],
		"no refusal that would make a 0.9.x client close its connection",
	);
});
