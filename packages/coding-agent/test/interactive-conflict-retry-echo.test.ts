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
