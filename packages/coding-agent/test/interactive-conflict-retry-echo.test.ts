/** A typed message sent again while another writer's entries stop each run is shown once in the chat (#5135). */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { SessionConflictError } from "../src/core/storage/session/errors.js";
import { createRig, type Rig, releaseOpenGates, waitFor } from "./helpers/busy-submission-rig.js";
import { showUserMessagesInChat } from "./helpers/interactive-submission-host.js";

const RETRIES = 5;

const rigs: Rig[] = [];
afterEach(async () => {
	releaseOpenGates();
	while (rigs.length > 0) await rigs.pop()?.stop();
});

describe.each(["local", "isolated"] as const)(
	"a typed message whose runs another writer's entries stop, %s (#5135)",
	(wiring) => {
		test("is shown once however often it is sent again, and leaves no echo behind", async () => {
			const rig = await createRig(wiring, "quiet", {});
			rigs.push(rig);
			if (rig.pair) await rig.pair.runtime.waitUntilResourcesReady();
			const chat = showUserMessagesInChat(rig.host);
			const session = rig.engine.session;
			const otherProcess = await SessionManager.open(
				session.sessionManager.getSessionStore(),
				session.sessionManager.getSessionId(),
			);
			const repeated = "repeated unsaved input";
			let conflicts = 0;
			session.subscribe((event) => {
				if (event.type === "agent_end" && session.getPersistenceFailure()?.conflict !== undefined) conflicts += 1;
			});
			for (let attempt = 0; attempt < RETRIES; attempt++) {
				await otherProcess.appendMessage({ role: "user", content: `other ${attempt}`, timestamp: Date.now() });
				rig.engine.setResponses([fauxAssistantMessage("never requested")]);
				const failuresBefore = conflicts;
				await rig.host.defaultEditor.onSubmit?.(repeated);
				await waitFor(
					"the run to stop on the other writer's entries and the submission to settle",
					() =>
						conflicts > failuresBefore &&
						!session.isStreaming &&
						Reflect.get(rig.host, "promptTurn") === undefined,
				);
				assert.ok(session.getPersistenceFailure()?.conflict instanceof SessionConflictError);
			}

			if (rig.pair) await rig.pair.drain();
			await waitFor(
				"the last submission to settle",
				() => (Reflect.get(rig.host, "deferredRenderedUserInputs") as string[]).length === 0,
			);
			assert.deepEqual(
				chat().filter((line) => line === repeated),
				[repeated],
			);
		});
	},
);

test("a typed message sent again while the host still shows the stopped run working is shown once, with no echo left behind (#5135)", async () => {
	const rig = await createRig("isolated", "quiet", {});
	rigs.push(rig);
	const pair = rig.pair;
	assert.ok(pair);
	await pair.runtime.waitUntilResourcesReady();
	const chat = showUserMessagesInChat(rig.host);
	const session = rig.engine.session;
	const otherProcess = await SessionManager.open(
		session.sessionManager.getSessionStore(),
		session.sessionManager.getSessionId(),
	);
	const repeated = "repeated unsaved input";
	let conflicts = 0;
	session.subscribe((event) => {
		if (event.type === "agent_end" && session.getPersistenceFailure()?.conflict !== undefined) conflicts += 1;
	});
	const stopOnOtherWriter = async (attempt: number, submit: () => Promise<void> | void): Promise<void> => {
		await otherProcess.appendMessage({ role: "user", content: `other ${attempt}`, timestamp: Date.now() });
		rig.engine.setResponses([fauxAssistantMessage("never requested")]);
		const failuresBefore = conflicts;
		const submitted = submit();
		await waitFor(
			"the engine to stop the run on the other writer's entries",
			() => conflicts > failuresBefore && !session.isStreaming,
		);
		return submitted;
	};

	await stopOnOtherWriter(0, () => rig.host.defaultEditor.onSubmit?.(repeated));
	await pair.drain();
	// The engine ends the next run while its agent_end is still on the way, so the host still shows the agent
	// working and sends the message typed now as one typed during a run.
	pair.holdHostTrafficFrom((record) => record.type === "agent_end");
	await stopOnOtherWriter(1, () => rig.host.defaultEditor.onSubmit?.(repeated));
	await pair.drain();
	assert.equal(rig.host.session.isStreaming, true, "the host must not have seen the run end yet");
	let submitted: Promise<void> | undefined;
	await stopOnOtherWriter(2, () => {
		submitted = Promise.resolve(rig.host.defaultEditor.onSubmit?.(repeated));
	});
	await pair.releaseHostTraffic();
	await submitted;
	await pair.drain();

	assert.ok(session.getPersistenceFailure()?.conflict instanceof SessionConflictError);
	assert.deepEqual(
		chat().filter((line) => line === repeated),
		[repeated],
		"the chat must show the message once",
	);
	assert.deepEqual(
		Reflect.get(rig.host, "deferredRenderedUserInputs"),
		[],
		"no echo of the message may be left to show again",
	);
});

test("a typed message sent again before the host reads the first send's run is shown once, with no echo left behind (#6126)", async () => {
	const rig = await createRig("isolated", "quiet", {});
	rigs.push(rig);
	const pair = rig.pair;
	assert.ok(pair);
	await pair.runtime.waitUntilResourcesReady();
	const chat = showUserMessagesInChat(rig.host);
	const session = rig.engine.session;
	const otherProcess = await SessionManager.open(
		session.sessionManager.getSessionStore(),
		session.sessionManager.getSessionId(),
	);
	const repeated = "repeated unsaved input";
	let conflicts = 0;
	session.subscribe((event) => {
		if (event.type === "agent_end" && session.getPersistenceFailure()?.conflict !== undefined) conflicts += 1;
	});
	const send = async (attempt: number): Promise<Promise<void>> => {
		await otherProcess.appendMessage({ role: "user", content: `other ${attempt}`, timestamp: Date.now() });
		rig.engine.setResponses([fauxAssistantMessage("never requested")]);
		const failuresBefore = conflicts;
		const submitted = Promise.resolve(rig.host.defaultEditor.onSubmit?.(repeated));
		await waitFor(
			"the engine to stop the run on the other writer's entries",
			() => conflicts > failuresBefore && !session.isStreaming,
		);
		return submitted;
	};

	// The host reads the engine's answer to the first send, then nothing of its run until both sends ended in the engine:
	// both runs reach the host in one read after the second send.
	pair.holdHostTrafficFrom((record) => record.type === "agent_start");
	const first = await send(0);
	await waitFor("the host to read the first send's answer", () => Reflect.get(rig.host, "promptTurn") === undefined);
	const second = await send(1);
	await pair.releaseHostTraffic();
	await Promise.all([first, second]);
	await pair.drain();

	assert.deepEqual(
		chat().filter((line) => line === repeated),
		[repeated],
		"the chat must show the message once",
	);
	assert.deepEqual(
		Reflect.get(rig.host, "deferredRenderedUserInputs"),
		[],
		"no echo of the message may be left to show again",
	);
});
