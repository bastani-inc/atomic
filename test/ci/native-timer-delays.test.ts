import assert from "node:assert/strict";
import { test } from "vitest";
import { auditNativeTimers, scanNativeTimers } from "../../scripts/timer-audit.mjs";

// The AST check knows literals and const arithmetic within a module. These remaining expressions have fixed bounds
// proven by their call sites or by the operation's cap. Match both the file and expression, and reject extra uses.
const exceptions: { file: string; expression: string; reason: string; count: number }[] = [];
function except(file: string, expression: string, reason: string, count = 1): void {
	exceptions.push({ file: `packages/${file}`, expression, reason, count });
}
function cli(file: string, expression: string, reason: string, count?: number): void {
	except(`coding-agent/src/${file}`, expression, reason, count);
}

except(
	"ai/src/auth/oauth/github-copilot.ts",
	"retryPolicy.maxElapsedMs",
	"Login uses only 0 or 5 seconds in this module.",
);
cli("core/bounded-model-refresh.ts", "INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS", "Imported 15-second limit.");
cli(
	"core/extensions/lazy-builtins/intercom.ts",
	"attempt === 0 ? STARTUP_JOIN_DELAY_MS : reconnectDelayMs(attempt - 1)",
	"Fixed initial delay and bounded reconnect delay table.",
);
cli("core/footer-data-provider.ts", "FooterDataProvider.WATCH_DEBOUNCE_MS", "Fixed class-level watch debounce.");
cli("core/footer-data-provider.ts", "FS_WATCH_RETRY_DELAY_MS", "Imported filesystem watch retry interval.");
cli(
	"core/lock-takeover.ts",
	"Math.min(ADVISORY_LOCK_RETRY_MS, remainingMs)",
	"At most one fixed advisory-lock poll interval.",
);
cli("core/model-runtime.ts", "POST_LOGOUT_AUTH_CHECK_TIMEOUT_MS", "Imported post-logout timeout.");
cli("core/rename-retry.ts", "backoff", "Grows only to RENAME_BACKOFF_MAX_MS; not the caller's total budget.");
cli("core/resume/blueprint/build-lock.ts", "ms", "Only fixed BUILD_LOCK_POLL_MS and LOCK_IO_RETRY_MS pauses.");
cli("core/resume/blueprint/process.ts", "ms", "Spawn refusals retry within a fixed two-second window.");
cli("core/session-append-recovery.ts", "delayMs", "Only FIRST_NOTICE_MS and REPEAT_NOTICE_MS.");
cli(
	"core/session-append-recovery.ts",
	"Math.min(remaining, BACKOFF_MS * (0.8 + Math.random() * 0.4))",
	"Jittered fixed backoff, never the full recovery budget.",
);
cli("core/storage/file-identity.ts", "ms", "The storage claim machine passes only CLAIM_PUBLICATION_POLL_MS.");
cli(
	"core/storage/migrations.ts",
	"ms * (0.5 + Math.random() / 2)",
	"The storage-setup poll is at most SETUP_MAX_POLL_MS.",
);
cli(
	"core/storage/migrations.ts",
	"pause * (0.5 + Math.random() / 2)",
	"The schema lock backoff is at most SCHEMA_SETUP_MAX_BACKOFF_MS.",
);
cli("core/storage/node-sqlite.ts", "ms", "Lock release notices recheck within LOCK_WAIT_RECHECK_MS.");
cli("core/storage/node-sqlite.ts", "Math.min(delay, remaining)", "Backoff starts small and cannot grow past 50 ms.");
cli(
	"core/storage/node-sqlite.ts",
	"delay",
	"The contended-write poll is at most LOCK_WAIT_RECHECK_MS, even for a longer lock budget.",
);
cli(
	"core/storage/schema-catalog.ts",
	"ms * (0.5 + Math.random() / 2)",
	"The schema batch poll is at most SQLITE_BATCH_MAX_POLL_MS.",
);
cli(
	"core/storage/session/jsonl-session-lock.ts",
	"LOCK_BACKOFF_MS[refusals++]",
	"Fixed table of transient Windows filesystem retries.",
	2,
);
cli("core/storage/session/jsonl-session-lock.ts", "wait", "Iterates the fixed LOCK_BACKOFF_MS table.");
cli(
	"core/storage/session/jsonl-session-store.ts",
	"LOCK_BACKOFF_MS[refusals++]",
	"Fixed table of transient Windows filesystem retries.",
);
cli("core/storage/session/jsonl-session-store.ts", "wait", "Iterates the fixed LOCK_BACKOFF_MS table.");
cli(
	"core/storage/session/jsonl-session-store.ts",
	"LOCK_BACKOFF_MS[attempt]",
	"Fixed table of transient Windows filesystem retries.",
);
cli("core/storage/session/stored-entries.ts", "delayMs", "Only the 20 ms fingerprint idle interval or 0.");
cli(
	"core/storage/sqlite-facade.ts",
	"Math.min(Math.random() * bound, deadline - performance.now())",
	"Busy retry jitter is capped by BUSY_RETRY_MAX_MS.",
);
cli(
	"core/storage/sqlite-facade.ts",
	"transientRetryDelayMs(failure.attempts)",
	"Transient retries cap the jittered delay within the fixed retry range.",
);
cli("core/storage/write-ahead-log.ts", "wait", "Only one poll from retryAfter; capped by RETRY_MAX_DELAY_MS.", 2);
cli("core/tools/bash.ts", "delay", "Remaining time within one 100 ms output-throttle interval on the monotonic clock.");
cli("core/tools/fetch-url.ts", "Math.min(timeoutMs, REMOTE_FETCH_TIMEOUT_MS)", "Hard 10-second cap for fetching URLs.");
cli("extensions/llama/client.ts", "ms", "Llama model polls use only 100, 250, or 500 ms.");
cli("extensions/mcp/runtime.ts", "CONNECT_RETRY_DELAYS_MS[0]", "Fixed connection-retry table (250 and 1000 ms).");
cli("extensions/mcp/runtime.ts", "delay", "One entry of the same fixed connection-retry table.");
cli("main-early-input.ts", "ms", "Startup-dialog input drains only in 5 ms polls and a 25 ms grace.");
cli("main.ts", "INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS", "Imported 15-second limit.", 2);
cli("main.ts", "ENGINE_SHUTDOWN_GRACE_MS", "Imported 5-second shutdown grace.");
cli("modes/interactive-engine/remote-component.ts", "PROMPT_SLOT_HOLD_MS", "Imported fixed prompt-slot hold budget.");
cli(
	"modes/interactive/chat-input-actions.ts",
	"delayMs",
	"Private clipboard cleanup scheduled with the fixed one-hour delay.",
);
cli("modes/interactive/components/armin.ts", "1000 / fps", "Animation speed is fixed at 30 or 60 fps.");
cli(
	"modes/interactive/components/countdown-timer.ts",
	"remaining - (seconds - 1) * 1000",
	"Only the remainder of the next visible second, not the full countdown.",
);
cli("modes/interactive/components/startup-identity.ts", "STARTUP_FRAME_MS", "Imported animation frame interval.");
cli(
	"modes/interactive/components/task-inspector.ts",
	"NAV_CONFIRM_WINDOW_MS + 50",
	"Imported 3-second confirmation window, plus 50 ms.",
	3,
);
cli(
	"modes/interactive/interactive-process-lifecycle.ts",
	"Math.max(CONSOLE_CLOSED_SHUTDOWN_MS - Math.max(0, notice.closedMsAgo), 0)",
	"Fixed shutdown grace minus a non-negative elapsed duration.",
);
cli(
	"modes/interactive/interactive-process-lifecycle.ts",
	"TERMINAL_LOST_SHUTDOWN_MS",
	"Imported fixed terminal-loss shutdown limit.",
);
cli(
	"modes/rpc/agent-panel-bridge.ts",
	"Math.max(0, windowStart + AGENT_PANEL_REFRESH_WINDOW_MS - now)",
	"Remaining time in a fixed render window, measured on the monotonic clock.",
);
cli("modes/rpc/rpc-mode.ts", "CONSOLE_CLOSED_SHUTDOWN_MS", "Imported fixed console-closure shutdown limit.");
cli("modes/rpc/rpc-terminal-drain.ts", "EXIT_DRAIN_TIMEOUT_MS", "Imported fixed exit-drain timeout.");
cli(
	"utils/compile-cache-installation-watch.ts",
	"intervalMs",
	"The only worker launcher passes INSTALLATION_CHECK_INTERVAL_MS.",
);
except(
	"subagents/src/extension/startup-maintenance.ts",
	"delayMs",
	"The scheduled startup cleanup uses only STARTUP_ARTIFACT_SCAN_DELAY_MS.",
);
except("subagents/src/runs/foreground/subagent-child-hold.ts", "ms", "Iterates the fixed HOLD_RETRY_DELAYS_MS table.");
except(
	"tui/src/components/windowed-container.ts",
	"Math.max(0, this.lastFullSweepAt + SWEEP_INTERVAL_MS - performance.now())",
	"Remaining time within a fixed sweep interval on the monotonic clock.",
);
except(
	"tui/src/tui-alt-screen.ts",
	"Math.max(0, first.timestamp + MULTI_CLICK_INTERVAL_MS + 1 - clickTime())",
	"Remaining time in the fixed multi-click window.",
);
except("tui/src/tui.ts", "delay", "Remaining time within the fixed 16 ms render interval.");

test("configurable native timer calls require the shared deadline helper (#6807)", () => {
	const calls = auditNativeTimers();
	const unmatched = new Set(calls);
	for (const item of exceptions) {
		const matches = calls.filter(({ file, expression }) => file === item.file && expression === item.expression);
		assert.equal(matches.length, item.count, `${item.file}: ${item.expression} (${item.reason})`);
		for (const match of matches) unmatched.delete(match);
	}
	assert.deepEqual(
		[...unmatched].map(({ file, line, expression }) => `${file}:${line}: ${expression}`),
		[],
		"Use @bastani/atomic-timers for dynamic delays. Record a specific reason here only for a provably bounded native timer.",
	);
});

test("the timer guard recognizes literal arithmetic, overflowing literals, and dynamic native aliases (#6807)", () => {
	const sites = scanNativeTimers(
		`import { setTimeout as pause } from "node:timers/promises";
		 const STEP_MS = 100;
		 setTimeout(tick, 2 * STEP_MS);
		 setInterval(tick, settings.pollMs);
		 globalThis.setTimeout(tick, 3_000_000_000);
		 await pause(waitMs);
		 AbortSignal.timeout(api.timeoutMs);`,
		"sample.ts",
	);
	assert.deepEqual(
		sites.map(({ expression }) => expression),
		["settings.pollMs", "3_000_000_000", "waitMs", "api.timeoutMs"],
	);
});
