import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Container, getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { AtomicWorkingLoader } from "../src/modes/interactive/components/atomic-working-status.ts";
import type { CountdownTimer } from "../src/modes/interactive/components/countdown-timer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
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

function rendered(mode: ReturnType<typeof makeMode>): string {
	return stripVTControlCharacters(mode.statusContainer.render(100).join("\n"));
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
		assert.match(rendered(mode), /∀ Retrying \(1\/3\) in 3s/);
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

test("summary retries use Atomic's indicator and stop it when the next attempt begins", async () => {
	const mode = makeMode();
	await emit(mode, {
		type: "summarization_retry_scheduled",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 3000,
		errorMessage: "Rate limit exceeded",
	});
	assert.match(rendered(mode), /∀ Retrying summary/);
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
