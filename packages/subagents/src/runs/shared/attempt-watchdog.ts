import type { ChildProcess } from "node:child_process";
import { trySignalChild } from "../../shared/post-exit-stdio-guard.ts";

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_WALL_MS = 60 * 60_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

export interface AttemptTimeoutConfig {
	idleMs: number;
	wallMs: number;
	killGraceMs: number;
}

export interface AttemptWatchdog {
	activity(): void;
	clear(): void;
}

/** Parse a millisecond override from the environment. Non-numeric values are
 * silently ignored (the default applies). Zero or negative values are clamped
 * to `0`, which callers treat as "timeout disabled". */
function envMs(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) return undefined;
	return value > 0 ? Math.floor(value) : 0;
}

function positiveEnvMs(name: string): number | undefined {
	const value = envMs(name);
	return value !== undefined && value > 0 ? value : undefined;
}

export function resolveAttemptTimeoutConfig(): AttemptTimeoutConfig {
	return {
		// `0` (or a negative value) disables the corresponding timeout entirely.
		idleMs: envMs("ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS") ?? DEFAULT_IDLE_MS,
		wallMs: envMs("ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS") ?? DEFAULT_WALL_MS,
		// The SIGTERM→SIGKILL grace period intentionally cannot be disabled: once a
		// watchdog trips, escalation must always be bounded. `0`, negative, or
		// non-numeric values fall back to the default.
		killGraceMs: positiveEnvMs("ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS") ?? DEFAULT_KILL_GRACE_MS,
	};
}

export function idleTimeoutMessage(idleMs: number): string {
	return `Subagent model attempt timed out after ${idleMs}ms without child activity.`;
}

export function wallTimeoutMessage(wallMs: number): string {
	return `Subagent model attempt timed out after ${wallMs}ms.`;
}

export function createAttemptWatchdog(params: {
	child: ChildProcess;
	config?: Partial<AttemptTimeoutConfig>;
	onTimeout: (message: string) => void;
	isSettled: () => boolean;
	/** Reports whether a tool call is currently executing in the child. A slow tool
	 * (long build, large test suite) can legitimately stay silent past the idle
	 * window, so an in-flight tool execution counts as activity and defers the idle
	 * trip. The wall-clock cap still bounds the whole attempt. */
	isToolActive?: () => boolean;
}): AttemptWatchdog {
	const config = { ...resolveAttemptTimeoutConfig(), ...(params.config ?? {}) };
	let idleTimer: NodeJS.Timeout | undefined;
	let wallTimer: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	let tripped = false;

	const clearIdle = () => {
		if (!idleTimer) return;
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const clearAll = () => {
		clearIdle();
		if (wallTimer) {
			clearTimeout(wallTimer);
			wallTimer = undefined;
		}
		if (killTimer) {
			clearTimeout(killTimer);
			killTimer = undefined;
		}
	};
	const trip = (message: string) => {
		if (tripped || params.isSettled()) return;
		tripped = true;
		clearIdle();
		params.onTimeout(message);
		trySignalChild(params.child, "SIGTERM");
		killTimer = setTimeout(() => {
			if (!params.isSettled()) trySignalChild(params.child, "SIGKILL");
		}, config.killGraceMs);
		killTimer.unref?.();
	};
	const scheduleIdle = () => {
		clearIdle();
		if (config.idleMs <= 0) return; // idle watchdog disabled
		idleTimer = setTimeout(() => {
			if (params.isToolActive?.()) {
				// Do not kill a healthy attempt that is busy inside a slow tool call;
				// re-arm the idle window and let the wall-clock cap bound the attempt.
				scheduleIdle();
				return;
			}
			trip(idleTimeoutMessage(config.idleMs));
		}, config.idleMs);
		idleTimer.unref?.();
	};

	scheduleIdle();
	if (config.wallMs > 0) {
		wallTimer = setTimeout(() => trip(wallTimeoutMessage(config.wallMs)), config.wallMs);
		wallTimer.unref?.();
	}

	return {
		activity() {
			if (!tripped && !params.isSettled()) scheduleIdle();
		},
		clear: clearAll,
	};
}
