import { type LongTimeout, setLongTimeout } from "@bastani/atomic-timers";

interface TimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

interface FileCoalescer {
	schedule(file: string, delayMs?: number): boolean;
	clear(): void;
}

const defaultTimerApi: TimerApi = {
	setTimeout: setLongTimeout,
	clearTimeout: (handle) => (handle as LongTimeout).clear(),
};

export function createFileCoalescer(
	handler: (file: string) => void,
	defaultDelayMs: number,
	timerApi: TimerApi = defaultTimerApi,
): FileCoalescer {
	const pending = new Map<string, unknown>();

	return {
		schedule(file: string, delayMs = defaultDelayMs): boolean {
			if (pending.has(file)) return false;
			const timer = timerApi.setTimeout(() => {
				pending.delete(file);
				handler(file);
			}, delayMs);
			pending.set(file, timer);
			return true;
		},
		clear(): void {
			for (const timer of pending.values()) {
				timerApi.clearTimeout(timer);
			}
			pending.clear();
		},
	};
}
