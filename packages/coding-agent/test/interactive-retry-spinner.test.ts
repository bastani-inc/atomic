import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Container, getKeybindings, setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { AtomicWorkingLoader } from "../src/modes/interactive/components/atomic-working-status.ts";
import type { CountdownTimer } from "../src/modes/interactive/components/countdown-timer.ts";
import { WorkingRunMeter } from "../src/modes/interactive/components/working-run-meter.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { setSummaryCancellable } from "../src/modes/interactive/interactive-summarization-retry-events.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const previousKeybindings = getKeybindings();
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	setKeybindings(previousKeybindings);
});

function makeMode() {
	return {
		isInitialized: true,
		workingRunMeter: new WorkingRunMeter(),
		programStatus: { handleEvent: vi.fn() },
		footer: { invalidate: () => {} },
		defaultEditor: { onEscape: vi.fn() },
		statusContainer: new Container(),
		retryLoader: undefined as AtomicWorkingLoader | undefined,
		retryCountdown: undefined as CountdownTimer | undefined,
		session: { abortRetry: vi.fn() },
		settingsManager: { getClearOnShrink: () => false },
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
	};
}

async function emit(mode: ReturnType<typeof makeMode>, event: AgentSessionEvent): Promise<void> {
	await InteractiveMode.prototype.handleEvent.call(mode as never, event);
}

function rendered(mode: ReturnType<typeof makeMode>, width = 100): string {
	// The clickable key hint's markers are terminal sequences too.
	return stripVTControlCharacters(stripTerminalSequences(mode.statusContainer.render(width).join("\n")));
}

/** The status rows at `width` columns, without their padding. */
function renderedRows(mode: ReturnType<typeof makeMode>, width: number): string[] {
	return rendered(mode, width)
		.split("\n")
		.map((row) => row.trimEnd());
}

for (const success of [true, false]) {
	test(`rate-limit retry uses Atomic frames and cleans up after success=${success}`, async () => {
		const mode = makeMode();
		const onEscape = mode.defaultEditor.onEscape;
		await emit(mode, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 3000,
			errorMessage: "Rate limit exceeded",
		});
		assert.match(rendered(mode), /∀ Retrying · rate limited · attempt 1\/3 in 3s {3}esc cancel/);
		for (let frame = 0; frame < 10; frame++) {
			vi.advanceTimersByTime(88);
			assert.match(rendered(mode), /∀/);
			assert.doesNotMatch(rendered(mode), /[\u2800-\u28ff]/u);
		}
		vi.advanceTimersByTime(120);
		assert.match(rendered(mode), /in 2s/);
		mode.defaultEditor.onEscape();
		assert.equal(mode.session.abortRetry.mock.calls.length, 1);
		await emit(mode, { type: "auto_retry_end", success, attempt: 1, finalError: success ? undefined : "Cancelled" });
		assert.equal(mode.defaultEditor.onEscape, onEscape);
		assert.equal(mode.retryLoader, undefined);
		assert.equal(mode.retryCountdown, undefined);
		assert.doesNotMatch(rendered(mode), /∀|Retrying/);
		assert.equal(vi.getTimerCount(), 0);
		assert.equal(mode.showError.mock.calls.length, success ? 0 : 1);
	});
}

test("a main chat bound during a backoff shows the remaining countdown, not a new wait (#5572)", async () => {
	const mode = Object.assign(makeMode(), {
		createExtensionUIContext: () => undefined,
		handleEvent: InteractiveMode.prototype.handleEvent,
		unsubscribe: () => {},
	});
	const onEscape = mode.defaultEditor.onEscape;
	Object.assign(mode.session, {
		subscribe: () => () => {},
		workflows: { observe: () => ({ dispose() {} }) },
		retryStatus: {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 8000,
			retryAt: Date.now() + 3000,
			errorMessage: "busy",
		},
	});
	InteractiveMode.prototype.subscribeToAgent.call(mode as never);
	vi.advanceTimersByTime(600);
	mode.unsubscribe();
	InteractiveMode.prototype.subscribeToAgent.call(mode as never);
	assert.match(rendered(mode), /Retrying · busy · attempt 1\/3 in 3s/);
	vi.advanceTimersByTime(400);
	assert.match(
		rendered(mode),
		/Retrying · busy · attempt 1\/3 in 2s/,
		"reattaching between ticks retains the same deadline",
	);
	mode.unsubscribe();
	await emit(mode, { type: "auto_retry_end", success: true, attempt: 1 });
	assert.equal(mode.defaultEditor.onEscape, onEscape);
	assert.equal(vi.getTimerCount(), 0);
});

test("summary retries use Atomic's indicator and stop it when the next attempt begins", async () => {
	const mode = makeMode();
	await emit(mode, {
		type: "summarization_retry_scheduled",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 3000,
		errorMessage: "Rate limit exceeded",
	});
	// Esc does not cancel a summary this chat did not start from the tree, so the line names no key.
	assert.match(rendered(mode), /∀ Retrying summary · rate limited · attempt 1\/3 in 3s *$/m);
	vi.advanceTimersByTime(1000);
	assert.match(rendered(mode), /in 2s/);
	await emit(mode, { type: "summarization_retry_attempt_start", source: "branchSummary" });
	assert.equal(mode.retryLoader, undefined);
	assert.equal(mode.retryCountdown, undefined);
	assert.match(rendered(mode), /∀ Summarizing branch/);
	await emit(mode, { type: "summarization_retry_finished" });
	assert.equal(vi.getTimerCount(), 0);
	assert.doesNotMatch(rendered(mode), /∀|Retrying|Summarizing/);
});

test("retry honors reduced motion and NO_COLOR while retaining the countdown", async () => {
	vi.stubEnv("ATOMIC_REDUCED_MOTION", "1");
	vi.stubEnv("NO_COLOR", "1");
	const mode = makeMode();
	await emit(mode, {
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 3000,
		errorMessage: "Rate limit exceeded",
	});
	assert.equal(vi.getTimerCount(), 1, "only the countdown timer should run");
	assert.match(rendered(mode), /∀ Retrying/);
	assert.doesNotMatch(mode.statusContainer.render(100).join("\n"), /\x1b\[(?:38|1|2)m|\x1b\[38;/);
	vi.advanceTimersByTime(1000);
	assert.match(rendered(mode), /in 2s/);
	await emit(mode, { type: "auto_retry_end", success: true, attempt: 1 });
	assert.equal(vi.getTimerCount(), 0);
});

test("a retry names why it waits and returns to Working… when its countdown ends", async () => {
	const mode = makeMode();
	await emit(mode, {
		type: "auto_retry_start",
		attempt: 2,
		maxAttempts: 3,
		delayMs: 4000,
		errorMessage: "Provider stream timed out after 300000ms without a new event (stream deadline exceeded)",
	});
	assert.match(rendered(mode), /∀ Retrying · response timed out · attempt 2\/3 in 4s {3}esc cancel/);
	vi.advanceTimersByTime(3000);
	assert.match(rendered(mode), /attempt 2\/3 in 1s/);
	vi.advanceTimersByTime(1000);
	assert.match(rendered(mode), /∀ Working… *$/m, "the next attempt is under way");
	assert.doesNotMatch(rendered(mode), /Retrying|cancel/);
	await emit(mode, { type: "auto_retry_end", success: true, attempt: 2 });
	assert.equal(vi.getTimerCount(), 0);
});

test("a summary retry names Esc where Esc cancels the summary", async () => {
	const mode = makeMode();
	setSummaryCancellable(mode as never, true);
	await emit(mode, {
		type: "summarization_retry_scheduled",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 2000,
		errorMessage: "503 Service Unavailable",
	});
	assert.match(rendered(mode), /∀ Retrying summary · server error 503 · attempt 1\/3 in 2s {3}esc cancel/);
	setSummaryCancellable(mode as never, false);
	await emit(mode, { type: "summarization_retry_finished" });
	assert.equal(vi.getTimerCount(), 0);
});

test("the retry line names the key Esc's action is bound to, and Esc when that action has no key", async () => {
	for (const [bindings, hint] of [
		[{ "app.interrupt": "ctrl+g" }, "ctrl+g cancel"],
		[{ "app.interrupt": [] }, "esc cancel"],
	] as const) {
		setKeybindings(new KeybindingsManager(bindings as never));
		const mode = makeMode();
		await emit(mode, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 2000,
			errorMessage: "529 overloaded_error: Overloaded",
		});
		assert.match(
			rendered(mode),
			new RegExp(`∀ Retrying · overloaded · attempt 1/3 in 2s {3}${hint.replace("+", "\\+")} *$`, "m"),
		);
		await emit(mode, { type: "auto_retry_end", success: true, attempt: 1 });
	}
});

const refused = "Content blocked by the provider's safety filter: the request was refused";

test("the main chat's retry line stays one row: the reason gives way first, then the key hint", async () => {
	const mode = makeMode();
	await emit(mode, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: refused });
	assert.deepEqual(renderedRows(mode, 80), [
		"",
		" ∀ Retrying · Content blocked by the provider… · attempt 2/3 in 4s   esc cancel",
	]);
	assert.deepEqual(renderedRows(mode, 40), ["", " ∀ Retrying · attempt 2/3 in 4s"]);
	await emit(mode, { type: "auto_retry_end", success: true, attempt: 2 });
});

test("a summary retry line stays one row in a narrow terminal", async () => {
	const mode = makeMode();
	setSummaryCancellable(mode as never, true);
	await emit(mode, {
		type: "summarization_retry_scheduled",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 2000,
		errorMessage: refused,
	});
	assert.deepEqual(renderedRows(mode, 80), [
		"",
		" ∀ Retrying summary · Content blocked by the… · attempt 1/3 in 2s   esc cancel",
	]);
	assert.deepEqual(renderedRows(mode, 40), ["", " ∀ Retrying summary · attempt 1/3 in 2s"]);
	setSummaryCancellable(mode as never, false);
	await emit(mode, { type: "summarization_retry_finished" });
});
