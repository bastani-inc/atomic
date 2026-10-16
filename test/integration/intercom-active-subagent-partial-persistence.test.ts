import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import { createDispatchCounter } from "../helpers/intercom-interrupt-probe.js";

test("a failed card commit retries without a duplicate visible card", async () => {
	const ended = new AbortController();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let inbound!: Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];
	let ctx!: ExtensionContext;
	const h = await createHarness({
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			executionEnded: ended.signal,
			depth: 1,
		},
		extensionFactories: [
			(pi) => {
				intercomHeavy(pi, {
					captureInboundHandler: (handler) => {
						inbound = handler;
					},
				});
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
		],
	});
	await h.session.bindExtensions({ mode: "print" });
	let amended = 0;
	const dispatches = createDispatchCounter([
		(context) => {
			if (context.messages.some((m) => getMessageText(m).includes("FLUSH-once"))) amended += 1;
			return fauxAssistantMessage("amended result");
		},
	]);
	h.setResponses([
		async () => {
			started.resolve();
			await release.promise;
			return fauxAssistantMessage("original result");
		},
		...dispatches.steps(3),
	]);
	const append = h.sessionManager.appendCustomMessageEntry.bind(h.sessionManager);
	let flushFailures = 0;
	const failure = new SessionConflictError(h.sessionManager.getSessionId(), 0, 1);
	const storage = vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation(async (...args) => {
		if (flushFailures === 0 && args[0] === "intercom_message") {
			flushFailures += 1;
			throw failure;
		}
		return append(...args);
	});
	const execution = h.session.prompt("original task");
	try {
		await started.promise;
		await inbound(
			ctx,
			{
				id: "flush-peer",
				name: "flush-peer",
				cwd: "/flush-peer",
				pid: 1,
				startedAt: 1,
				lastActivity: 1,
				model: "faux",
			},
			{ id: "flush-once", timestamp: Date.now(), content: { text: "FLUSH-once" } },
		);
		await vi.waitFor(() => assert.equal(flushFailures, 1));
		release.resolve();
		await execution;
		const cards = h.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom_message" && e.customType === "intercom_message");
		assert.equal(cards.length, 1, "the same occurrence must not be appended twice");
		assert.equal(amended, 1, "the hidden model-facing reconciliation is delivered exactly once");
		assert.equal(dispatches.counts.valid, 1);
		assert.equal(
			h.session.messages.filter((m) => m.role === "custom" && m.customType === "intercom_message").length,
			1,
			"one live card in session state",
		);
	} finally {
		storage.mockRestore();
		release.resolve();
		ended.abort();
		await h.session.abort();
		await execution.catch(() => {});
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		h.session.pauseQueuedMessages();
		h.cleanup();
	}
});
