import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { auditNativeTimers, scanNativeTimers } from "../../scripts/timer-audit.mjs";

// The checker can prove small constants; these remaining expressions have fixed bounds
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
cli(
	"core/extensions/lazy-builtins/intercom.ts",
	"attempt === 0 ? STARTUP_JOIN_DELAY_MS : reconnectDelayMs(attempt - 1)",
	"Fixed initial delay and bounded reconnect delay table.",
);
cli(
	"core/lock-takeover.ts",
	"Math.min(ADVISORY_LOCK_RETRY_MS, remainingMs)",
	"At most one fixed advisory-lock poll interval.",
);
cli("core/rename-retry.ts", "backoff", "Grows only to RENAME_BACKOFF_MAX_MS; not the caller's total budget.");
cli("core/resume/blueprint/build-lock.ts", "ms", "Only fixed BUILD_LOCK_POLL_MS and LOCK_IO_RETRY_MS pauses.");
cli("core/resume/blueprint/ledger.ts", "delay", "Ledger lock backoff is capped by the fixed 250 ms maximum.");
cli("core/resume/blueprint/process.ts", "ms", "Spawn refusals retry within a fixed two-second window.");
cli(
	"core/resume/blueprint/process.ts",
	"Number.NaN",
	"A literal NaN gives a one-turn timer and preserves the runtime's invalid-budget warning.",
);
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
cli(
	"modes/interactive/chat-input-actions.ts",
	"delayMs",
	"Private clipboard cleanup scheduled with the fixed one-hour delay.",
);
cli(
	"modes/interactive/components/countdown-timer.ts",
	"remaining - (seconds - 1) * 1000",
	"Only the remainder of the next visible second, not the full countdown.",
);
cli(
	"modes/interactive/interactive-process-lifecycle.ts",
	"Math.max(CONSOLE_CLOSED_SHUTDOWN_MS - Math.max(0, notice.closedMsAgo), 0)",
	"Fixed shutdown grace minus a non-negative elapsed duration.",
);
cli(
	"modes/rpc/agent-panel-bridge.ts",
	"Math.max(0, windowStart + AGENT_PANEL_REFRESH_WINDOW_MS - now)",
	"Remaining time in a fixed render window, measured on the monotonic clock.",
);
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

test("the guard resolves shadowed constants and detects imported, assigned, and destructured aliases (#6807)", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-native-timer-guard-")));
	const config = join(root, "tsconfig.json");
	try {
		writeFileSync(
			config,
			JSON.stringify({
				compilerOptions: {
					module: "NodeNext",
					target: "ES2024",
					typeRoots: [fileURLToPath(new URL("../../node_modules/@types", import.meta.url))],
					types: ["node"],
				},
				files: ["sample.mts", "consumer.mts"],
			}),
		);
		writeFileSync(
			join(root, "sample.mts"),
			`import { setTimeout as pause } from "node:timers/promises";
			declare const settings: {pollMs:number};
			declare const api: {timeoutMs:number};
			declare const waitMs: number;
			declare function tick(): void;
			const STEP_MS = 100;
			setTimeout(tick, 2 * STEP_MS);
			function shadow(STEP_MS: number) { setTimeout(tick, STEP_MS); }
			setInterval(tick, settings.pollMs);
			globalThis.setTimeout(tick, 3_000_000_000);
			await pause(waitMs);
			AbortSignal.timeout(api.timeoutMs);
			const arm = globalThis.setTimeout;
			arm(tick, settings.pollMs);
			const {setInterval: repeat} = globalThis;
			repeat(tick, waitMs);`,
		);
		writeFileSync(join(root, "aliases.mts"), "export const arm = globalThis.setTimeout;");
		writeFileSync(
			join(root, "consumer.mts"),
			`import { arm } from "./aliases.mjs";
			declare const delay: number;
			arm(() => {}, delay);`,
		);
		assert.deepEqual(
			scanNativeTimers(root, config, ["sample.mts", "consumer.mts"]).map(({ expression }) => expression),
			[
				"STEP_MS",
				"settings.pollMs",
				"3_000_000_000",
				"waitMs",
				"api.timeoutMs",
				"settings.pollMs",
				"waitMs",
				"delay",
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
