import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { estimateTokens } from "../src/core/compaction/compaction.js";
import { buildCompactorMessages } from "../src/core/compaction/compactor.js";
import { convertToLlm } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createHarness, type Harness } from "./suite/harness.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});
async function harness(options: Parameters<typeof createHarness>[0]) {
	const h = await createHarness(options);
	cleanups.push(() => h.cleanup());
	return h;
}
const fail = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
const retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
const savedLines = (manager: SessionManager) =>
	manager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === "atomic.turn-outcome.v1" ? [entry.content] : [],
		);

test("a saved retry failure precedes the follow-up and is absent from its request, token count and compaction (#5649)", async () => {
	const h = await harness({ settings: { retry } });
	h.setResponses([fail(), fail()]);
	await h.session.prompt("first");
	const reopened = await SessionManager.open(h.sessionManager.getSessionStore(), h.sessionManager.getSessionId());
	const resumed = await harness({ sessionManager: reopened });
	let request: string | undefined;
	resumed.setResponses([
		(context) => {
			request = JSON.stringify(context);
			return fauxAssistantMessage("ok");
		},
	]);
	await resumed.session.prompt("follow-up");
	const lines = reopened.buildSessionContext().messages;
	const outcome = lines.find(
		(line) => line.role === "custom" && line.content === "Error: Retry failed after 1 attempts: overloaded_error",
	);
	assert.ok(outcome);
	assert.deepEqual(
		lines.flatMap((m) =>
			m.role === "user" || m.role === "custom"
				? [
						typeof m.content === "string"
							? m.content
							: m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
					]
				: [],
		),
		["first", "Error: Retry failed after 1 attempts: overloaded_error", "follow-up"],
	);
	assert.equal(estimateTokens(outcome), 0);
	assert.deepEqual(
		buildCompactorMessages([outcome], () => false),
		[],
	);
	assert.deepEqual(convertToLlm([outcome]), []);
	assert.match(request ?? "", /follow-up/);
	assert.doesNotMatch(request!, /Retry failed/);
});

test.each([false, true])(
	"the live retry event does not wait for its history write (refused: %s) (#5649)",
	async (refused) => {
		const h = await harness({ settings: { retry } });
		h.setResponses([fail(), fail()]);
		const store = h.sessionManager.getSessionStore();
		const append = store.append.bind(store);
		const gate = Promise.withResolvers<void>();
		const writing = Promise.withResolvers<void>();
		store.append = async (...args) => {
			if (args[1].some((e) => e.type === "custom_message" && e.customType === "atomic.turn-outcome.v1")) {
				writing.resolve();
				await gate.promise;
				if (refused) throw new Error("Write refused");
			}
			return append(...args);
		};
		let delivered = 0;
		h.session.subscribe((e) => {
			if (e.type === "auto_retry_end" && !e.success) delivered++;
		});
		const prompt = h.session.prompt("hello");
		try {
			await writing.promise;
			assert.equal(delivered, 1);
		} finally {
			gate.resolve();
			await prompt;
		}
		assert.deepEqual(
			savedLines(h.sessionManager),
			refused ? [] : ["Error: Retry failed after 1 attempts: overloaded_error"],
		);
		assert.equal(
			h.events.filter((e) => e.type === "message_start" && e.message.role === "custom").length,
			0,
			"no second live row",
		);
	},
);

test("manual compaction cancellation leaves one saved diagnostic after the reply (#5649)", async () => {
	const started = Promise.withResolvers<void>();
	const h: Harness = await harness({
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async ({ signal }) => {
					started.resolve();
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
					return { cancel: true };
				});
			},
		],
	});
	h.setResponses([fauxAssistantMessage("hi")]);
	await h.session.prompt("hello");
	const compact = h.session.compact();
	await started.promise;
	h.session.abortCompaction();
	await assert.rejects(compact, /Compaction cancelled/);
	await vi.waitFor(() => assert.deepEqual(savedLines(h.sessionManager), ["Error: Compaction cancelled"]));
	const manager = await SessionManager.open(h.sessionManager.getSessionStore(), h.sessionManager.getSessionId());
	assert.deepEqual(
		manager
			.buildSessionContext()
			.messages.slice(-2)
			.map((m) => m.role),
		["assistant", "custom"],
	);
});
