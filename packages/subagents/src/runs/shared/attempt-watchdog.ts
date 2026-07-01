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

function positiveEnvMs(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function resolveAttemptTimeoutConfig(): AttemptTimeoutConfig {
	return {
		idleMs: positiveEnvMs("ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS") ?? DEFAULT_IDLE_MS,
		wallMs: positiveEnvMs("ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS") ?? DEFAULT_WALL_MS,
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
		idleTimer = setTimeout(() => trip(idleTimeoutMessage(config.idleMs)), config.idleMs);
		idleTimer.unref?.();
	};

	scheduleIdle();
	wallTimer = setTimeout(() => trip(wallTimeoutMessage(config.wallMs)), config.wallMs);
	wallTimer.unref?.();

	return {
		activity() {
			if (!tripped && !params.isSettled()) scheduleIdle();
		},
		clear: clearAll,
	};
}
