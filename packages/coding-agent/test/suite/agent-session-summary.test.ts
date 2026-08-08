import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummaryEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * `_maybeGenerateSessionSummary` runs fire-and-forget after `agent_end`. These tests drive real
 * turns through the faux provider and assert on what reaches the session file.
 */

/** Bounded wait for the background summary; the faux provider answers in-process. */
const SUMMARY_DEADLINE_MS = 2_000;
/** Long enough for a summary that was going to happen to have happened. */
const SUMMARY_SETTLE_MS = 250;

function summaryEntries(harness: Harness): SessionSummaryEntry[] {
	return harness.sessionManager.getEntries().filter((e): e is SessionSummaryEntry => e.type === "session_summary");
}

async function waitForSummary(harness: Harness): Promise<SessionSummaryEntry> {
	const deadline = Date.now() + SUMMARY_DEADLINE_MS;
	while (Date.now() < deadline) {
		const found = summaryEntries(harness);
		if (found.length > 0) return found[found.length - 1]!;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for a session_summary entry");
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, SUMMARY_SETTLE_MS));
}

/** Two turns, so the branch clears the minimum-entry guard. */
async function runTwoTurns(harness: Harness): Promise<void> {
	await harness.session.prompt("add resume summaries");
	await harness.session.prompt("now wire up the picker");
}

describe("session summary generation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends a summary anchored to the last conversation message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("Wiring resume summaries into the session picker"),
		]);

		await runTwoTurns(harness);
		const summary = await waitForSummary(harness);

		expect(summary.summary).toBe("Wiring resume summaries into the session picker");

		// The anchor must be the newest user/assistant message entry, never the leaf.
		const conversation = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
		expect(summary.summarizedThroughId).toBe(conversation[conversation.length - 1]?.id);
	});

	it("does not regenerate while the conversation has not moved on", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("a summary"),
		]);

		await runTwoTurns(harness);
		await waitForSummary(harness);
		expect(harness.getPendingResponseCount()).toBe(0);

		// A second idle with no new messages must not spend another request.
		await harness.session._maybeGenerateSessionSummary();
		await settle();

		expect(summaryEntries(harness)).toHaveLength(1);
	});

	it("does not persist a summary once tree navigation has left the branch", async () => {
		// A branch_summary is not a conversation message, and navigating to an existing assistant
		// message leaves the last message id unchanged, so the anchor check alone cannot catch this.
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("a summary of the abandoned branch"),
		]);

		const requestStarted = Promise.withResolvers<void>();
		const releaseRequest = Promise.withResolvers<void>();
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			// Hold the summary request open so the navigation lands while it is in flight.
			async () => {
				requestStarted.resolve();
				await releaseRequest.promise;
				return fauxAssistantMessage("a summary of the abandoned branch");
			},
		]);

		await runTwoTurns(harness);
		await requestStarted.promise;

		// Push the leaf past the last assistant with a non-message entry, so navigating back to
		// that message moves the branch while leaving the anchor untouched.
		harness.session.setSessionName("pinned");
		const assistants = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		await harness.session.navigateTree(assistants[assistants.length - 1]!.id);

		releaseRequest.resolve();
		await settle();

		expect(summaryEntries(harness)).toHaveLength(0);
	});

	it("generates nothing when the setting is disabled", async () => {
		const harness = await createHarness({ settings: { sessionSummary: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([fauxAssistantMessage("first turn"), fauxAssistantMessage("second turn")]);

		await runTwoTurns(harness);
		await settle();

		expect(summaryEntries(harness)).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("swallows a credential failure instead of rejecting", async () => {
		// Regression: _getRequiredRequestAuth throws outright when no key is configured, and the
		// caller is `void this._maybeGenerateSessionSummary()`. An escaping rejection became an
		// unhandled rejection that took down a CLI child mid-run.
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });

		// Build a branch directly: without credentials the session cannot run real turns.
		harness.sessionManager.appendMessage({ role: "user", content: "add resume summaries", timestamp: 1 });
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			timestamp: 2,
			stopReason: "stop",
			provider: "faux",
			model: "faux",
			api: "anthropic-messages",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		});
		harness.sessionManager.appendMessage({ role: "user", content: "and the picker", timestamp: 3 });
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done again" }],
			timestamp: 4,
			stopReason: "stop",
			provider: "faux",
			model: "faux",
			api: "anthropic-messages",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		});

		await expect(harness.session._maybeGenerateSessionSummary()).resolves.toBeUndefined();
		expect(summaryEntries(harness)).toHaveLength(0);
	});

	it("generates nothing in non-interactive modes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// No bindExtensions call: the session stays in its default "print" mode.
		harness.setResponses([fauxAssistantMessage("first turn"), fauxAssistantMessage("second turn")]);

		await runTwoTurns(harness);
		await settle();

		expect(summaryEntries(harness)).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not persist a summary once the conversation has outrun it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("third turn"),
		]);

		await runTwoTurns(harness);
		// Start a summary, then land another turn before it can be persisted.
		const pending = harness.session._maybeGenerateSessionSummary();
		await harness.session.prompt("and one more thing");
		await pending;
		await settle();

		for (const entry of summaryEntries(harness)) {
			const conversation = harness.sessionManager
				.getEntries()
				.filter((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
			expect(entry.summarizedThroughId).toBe(conversation[conversation.length - 1]?.id);
		}
	});

	it("still generates when the launch happens while the agent reports streaming", async () => {
		// `agent_end` fires with isStreaming still true, and the flag survives the whole microtask
		// queue — it only clears a macrotask later. Generation used to depend on _checkCompaction
		// happening to cross that boundary before the guard was read: true in this harness, false
		// in the real TUI, where the feature silently produced nothing and nothing retried it.
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("a summary generated after idle"),
		]);

		const launches: Promise<void>[] = [];
		let streamingAtLaunch = false;
		harness.session.agent.subscribe((event: AgentEvent) => {
			if (event.type !== "agent_end") return;
			if (harness.session.isStreaming) streamingAtLaunch = true;
			launches.push(harness.session._maybeGenerateSessionSummary());
		});

		await runTwoTurns(harness);
		await Promise.all(launches);

		// Guards the regression itself: if this ever goes false the test has stopped reproducing
		// the condition and would pass for the wrong reason.
		expect(streamingAtLaunch).toBe(true);

		const summary = await waitForSummary(harness);
		expect(summary.summary).toBe("a summary generated after idle");
	});

	it("runs no summary work once the session has been disposed", async () => {
		// Work queued before the AbortController exists cannot be reached by abortSessionSummary(),
		// so disposal has to be recorded as state and re-checked at every async boundary.
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			// Turn 2's own launch reaches the provider before dispose() lands, and is cancelled
			// mid-request. Budgeting it keeps the response below as the one thing the disposal
			// guard has to protect.
			fauxAssistantMessage("cancelled by disposal"),
			fauxAssistantMessage("must never be requested"),
		]);

		await runTwoTurns(harness);

		harness.session.dispose();
		// Release the launch that was queued before disposal.
		await harness.session._maybeGenerateSessionSummary();
		await settle();

		expect(summaryEntries(harness)).toHaveLength(0);
		// The third response is still unconsumed, so the provider was never contacted.
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not persist a summary when disposal lands mid-request", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });

		const requestStarted = Promise.withResolvers<void>();
		const releaseRequest = Promise.withResolvers<void>();
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			async () => {
				requestStarted.resolve();
				await releaseRequest.promise;
				return fauxAssistantMessage("summary for a disposed session");
			},
		]);

		await runTwoTurns(harness);
		const pending = harness.session._maybeGenerateSessionSummary();
		await requestStarted.promise;

		harness.session.dispose();
		releaseRequest.resolve();
		await pending;
		await settle();

		expect(summaryEntries(harness)).toHaveLength(0);
	});

	it("collapses concurrent launches into a single request", async () => {
		// The token is claimed before waitForIdle(), so two launches can now be parked at once —
		// a state that could not exist when the claim happened after the guards.
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("the only summary"),
		]);

		await runTwoTurns(harness);
		await Promise.all([
			harness.session._maybeGenerateSessionSummary(),
			harness.session._maybeGenerateSessionSummary(),
		]);
		await settle();

		expect(summaryEntries(harness)).toHaveLength(1);
		// One summary response consumed, not two.
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("lets a new prompt supersede a launch that is still parked", async () => {
		// A parked launch holds no AbortController, so abortSessionSummary() has to bump the token
		// to reach it. Without that, prompt() cancels nothing and the stale launch runs anyway.
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			// Turn 2's own launch is already in flight when the next prompt arrives, so it spends
			// a request that prompt() then cancels. The parked launch under test spends none.
			fauxAssistantMessage("summary the next prompt cancels"),
			fauxAssistantMessage("third turn"),
			fauxAssistantMessage("the surviving summary"),
		]);

		await runTwoTurns(harness);
		const parked = harness.session._maybeGenerateSessionSummary();
		await harness.session.prompt("and one more thing");
		await parked;
		await settle();

		// Exactly one summary, and every response accounted for: the parked launch never spent a
		// request of its own.
		expect(summaryEntries(harness)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("never escapes as an unhandled rejection", async () => {
		// Production calls this as `void this._maybeGenerateSessionSummary()`, so anything that
		// throws — including the guards ahead of the first await — surfaces as an unhandled
		// rejection rather than a caught error. One of those took down a CLI child mid-run.
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			const harness = await createHarness({ withConfiguredAuth: false });
			harnesses.push(harness);
			await harness.session.bindExtensions({ mode: "tui" });

			harness.sessionManager.appendMessage({ role: "user", content: "add resume summaries", timestamp: 1 });
			harness.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				timestamp: 2,
				stopReason: "stop",
				provider: "faux",
				model: "faux",
				api: "anthropic-messages",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			});
			harness.sessionManager.appendMessage({ role: "user", content: "and the picker", timestamp: 3 });
			harness.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done again" }],
				timestamp: 4,
				stopReason: "stop",
				provider: "faux",
				model: "faux",
				api: "anthropic-messages",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			});

			// Deliberately not awaited: this is the production call shape.
			void harness.session._maybeGenerateSessionSummary();
			await settle();

			expect(rejections).toEqual([]);
			expect(summaryEntries(harness)).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});
