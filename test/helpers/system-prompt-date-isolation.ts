export interface MiddayTimezoneIsolationHandle {
	readonly timezone: string;
	restore(): void;
}

/**
 * Whole-hour UTC offset in `[-12, +12]` that puts `now` into local `[11:30, 12:29]`, leaving at least 11 hours 30
 * minutes before the next local midnight (and after the previous one).
 */
export function middayOffsetHours(now: Date = new Date()): number {
	return (now.getUTCMinutes() >= 30 ? 11 : 12) - now.getUTCHours();
}

/**
 * Fixed-offset IANA `Etc/GMT` timezone name (no DST) that places `now` near local noon.
 *
 * IANA `Etc/GMT` uses the POSIX inverted sign convention: `Etc/GMT-N` is UTC+N (east of Greenwich) and `Etc/GMT+N` is
 * UTC-N (west of Greenwich). Both Node (V8/ICU) and Bun honor `Etc/GMT` and `Etc/GMT±1..12` on Linux, macOS, and
 * Windows, both via `process.env.TZ` and via child-process `TZ`.
 */
export function middayTimezone(now: Date = new Date()): string {
	const offsetHours = middayOffsetHours(now);
	if (offsetHours === 0) return "Etc/GMT";
	return offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${-offsetHours}`;
}

/**
 * Pin the worker's local timezone (`process.env.TZ`) to a fixed-offset IANA `Etc/GMT` zone near local noon once at
 * worker startup, and restore it in `beforeEach`.
 *
 * Local calendar dates (`buildSystemPromptSections()`) stay more than 11 hours away from local midnight for the entire
 * test run without modifying `Date.now()`, UTC timestamps, or shipped source code, while fake `Date` timers
 * (`vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime(...)`) still advance calendar days normally.
 */
export function installMiddayTimezoneIsolation(
	hooks?: { readonly beforeEach: (fn: () => void) => void },
	options?: { readonly now?: Date; readonly env?: NodeJS.ProcessEnv },
): MiddayTimezoneIsolationHandle {
	const env = options?.env ?? process.env;
	const hadTz = Object.hasOwn(env, "TZ");
	const previousTz = env.TZ;
	const timezone = middayTimezone(options?.now ?? new Date());
	env.TZ = timezone;

	hooks?.beforeEach(() => {
		env.TZ = timezone;
	});

	return {
		timezone,
		restore() {
			if (hadTz) env.TZ = previousTz;
			else delete env.TZ;
		},
	};
}

/**
 * Forward the worker's `TZ` into a child process's explicit environment unless the caller already named `TZ`
 * (including setting `TZ: "UTC"` or `TZ: undefined` to opt out).
 */
export function withTestTimezone<T extends Record<string, string | undefined>>(
	env: T,
	sourceEnv: NodeJS.ProcessEnv = process.env,
): T {
	if (Object.hasOwn(env, "TZ")) return env;
	const tz = sourceEnv.TZ;
	if (!tz) return env;
	return { ...env, TZ: tz };
}
