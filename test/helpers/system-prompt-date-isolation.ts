export interface MiddayTimezoneIsolationHandle {
	readonly timezone: string;
	restore(): void;
}

export interface MiddayTimezoneHooks {
	readonly beforeEach: (fn: () => void) => void;
	readonly afterEach?: (fn: () => void) => void;
	readonly afterAll?: (fn: () => void) => void;
}

type CapturedTimezone = ReadonlyArray<readonly [string, string | undefined]>;

function isTimezoneKeyName(key: string, caseInsensitive: boolean): boolean {
	return caseInsensitive ? key.toLowerCase() === "tz" : key === "TZ";
}

/**
 * Whether `env` explicitly names `TZ` (including `{ TZ: undefined }` or `{ TZ: "" }` opt-outs). On Windows,
 * environment variable names are case-insensitive, so any case variant (`tz`, `Tz`, `tZ`, `TZ`) counts.
 */
export function hasTimezoneKey(
	env: Record<string, string | undefined>,
	caseInsensitive: boolean = process.platform === "win32",
): boolean {
	if (Object.hasOwn(env, "TZ")) return true;
	if (!caseInsensitive) return false;
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "tz") return true;
	}
	return false;
}

/** Read the effective `TZ` string from `env`, matching case-insensitively on Windows. */
export function readTimezone(
	env: NodeJS.ProcessEnv | Record<string, string | undefined>,
	caseInsensitive: boolean = process.platform === "win32",
): string | undefined {
	if (Object.hasOwn(env, "TZ")) return env.TZ;
	if (!caseInsensitive) return undefined;
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "tz") return env[key];
	}
	return undefined;
}

function captureTimezone(env: NodeJS.ProcessEnv, caseInsensitive: boolean): CapturedTimezone {
	if (!caseInsensitive) {
		return Object.hasOwn(env, "TZ") ? [["TZ", env.TZ]] : [];
	}
	const entries: Array<readonly [string, string | undefined]> = [];
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "tz") entries.push([key, env[key]]);
	}
	return entries;
}

function clearTimezoneKeys(env: NodeJS.ProcessEnv, caseInsensitive: boolean): void {
	if (!caseInsensitive) {
		delete env.TZ;
		return;
	}
	for (const key of Object.keys(env)) {
		if (isTimezoneKeyName(key, true)) delete env[key];
	}
}

function restoreTimezone(env: NodeJS.ProcessEnv, saved: CapturedTimezone, caseInsensitive: boolean): void {
	clearTimezoneKeys(env, caseInsensitive);
	for (const [key, value] of saved) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
}

function setWorkerTimezone(env: NodeJS.ProcessEnv, timezone: string, caseInsensitive: boolean): void {
	clearTimezoneKeys(env, caseInsensitive);
	env.TZ = timezone;
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
 * worker startup.
 *
 * `beforeEach` snapshots the current `TZ` (preserving any `TZ` a test file set at top level or in `beforeAll`),
 * `afterEach` restores that snapshot so per-test mutations never leak to later tests, and `afterAll` restores the
 * worker's midday `TZ` before the next test file runs in the same worker.
 */
export function installMiddayTimezoneIsolation(
	hooks?: MiddayTimezoneHooks,
	options?: { readonly now?: Date; readonly env?: NodeJS.ProcessEnv; readonly caseInsensitive?: boolean },
): MiddayTimezoneIsolationHandle {
	const env = options?.env ?? process.env;
	const caseInsensitive = options?.caseInsensitive ?? process.platform === "win32";
	const initialSnapshot = captureTimezone(env, caseInsensitive);
	const timezone = middayTimezone(options?.now ?? new Date());
	setWorkerTimezone(env, timezone, caseInsensitive);

	const preTestSnapshots: CapturedTimezone[] = [];
	if (hooks) {
		hooks.beforeEach(() => {
			preTestSnapshots.push(captureTimezone(env, caseInsensitive));
		});
		hooks.afterEach?.(() => {
			const saved = preTestSnapshots.pop();
			if (saved !== undefined) restoreTimezone(env, saved, caseInsensitive);
		});
		hooks.afterAll?.(() => {
			preTestSnapshots.length = 0;
			setWorkerTimezone(env, timezone, caseInsensitive);
		});
	}

	return {
		timezone,
		restore() {
			preTestSnapshots.length = 0;
			restoreTimezone(env, initialSnapshot, caseInsensitive);
		},
	};
}

/**
 * Forward the worker's `TZ` into a child process's explicit environment unless the caller already named `TZ`
 * (case-insensitively on Windows, including setting `TZ: "UTC"` or `TZ: undefined` to opt out).
 */
export function withTestTimezone<T extends Record<string, string | undefined>>(
	env: T,
	sourceEnv: NodeJS.ProcessEnv = process.env,
	options?: { readonly caseInsensitive?: boolean },
): T {
	const caseInsensitive = options?.caseInsensitive ?? process.platform === "win32";
	if (hasTimezoneKey(env, caseInsensitive)) return env;
	const tz = readTimezone(sourceEnv, caseInsensitive);
	if (!tz) return env;
	return { ...env, TZ: tz };
}
