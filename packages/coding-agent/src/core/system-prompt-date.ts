const SYSTEM_PROMPT_DATE_PROVIDER = Symbol.for("atomic-coding-agent/system-prompt-date@1");

/**
 * Environment variable carrying a pinned local `YYYY-MM-DD` date for child processes spawned by the test suites so
 * midnight rollovers never inject unexpected `<date>` prompt updates mid-test. Not part of the public API.
 */
export const SYSTEM_PROMPT_DATE_ENV = "ATOMIC_TEST_SYSTEM_PROMPT_DATE";

export type SystemPromptDateProvider = () => string | undefined;

type SystemPromptDateSlot = { [SYSTEM_PROMPT_DATE_PROVIDER]?: SystemPromptDateProvider };

function isAsciiDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
	if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
	if (month >= 1 && month <= 12) return 31;
	return 0;
}

/** Whether `value` is a valid Gregorian calendar date formatted as `YYYY-MM-DD`. */
export function isCalendarDate(value: string | undefined): value is string {
	if (value === undefined || value.length !== 10) return false;
	if (value.charCodeAt(4) !== 45 || value.charCodeAt(7) !== 45) return false;
	const y0 = value.charCodeAt(0);
	const y1 = value.charCodeAt(1);
	const y2 = value.charCodeAt(2);
	const y3 = value.charCodeAt(3);
	const m0 = value.charCodeAt(5);
	const m1 = value.charCodeAt(6);
	const d0 = value.charCodeAt(8);
	const d1 = value.charCodeAt(9);
	if (
		!isAsciiDigit(y0) ||
		!isAsciiDigit(y1) ||
		!isAsciiDigit(y2) ||
		!isAsciiDigit(y3) ||
		!isAsciiDigit(m0) ||
		!isAsciiDigit(m1) ||
		!isAsciiDigit(d0) ||
		!isAsciiDigit(d1)
	) {
		return false;
	}
	const year = (y0 - 48) * 1000 + (y1 - 48) * 100 + (y2 - 48) * 10 + (y3 - 48);
	const month = (m0 - 48) * 10 + (m1 - 48);
	const day = (d0 - 48) * 10 + (d1 - 48);
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Format `date` as a local `YYYY-MM-DD` calendar date. */
export function formatLocalCalendarDate(date: Date): string {
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Install or clear the process-wide system-prompt calendar date provider for tests. Returns the previous provider so
 * callers can restore it. Lives in a process-wide Symbol slot rather than module state so it holds across
 * `vi.resetModules()` and mixed source/dist copies. Not part of the public API.
 */
export function setSystemPromptDateProviderForTest(
	provider: SystemPromptDateProvider | undefined,
): SystemPromptDateProvider | undefined {
	const slot = globalThis as SystemPromptDateSlot;
	const previous = slot[SYSTEM_PROMPT_DATE_PROVIDER];
	if (provider === undefined) {
		delete slot[SYSTEM_PROMPT_DATE_PROVIDER];
	} else {
		slot[SYSTEM_PROMPT_DATE_PROVIDER] = provider;
	}
	return previous;
}

/** The active system-prompt date provider, if one is installed for tests. */
export function systemPromptDateProviderForTest(): SystemPromptDateProvider | undefined {
	return (globalThis as SystemPromptDateSlot)[SYSTEM_PROMPT_DATE_PROVIDER];
}

/**
 * Resolve the calendar date for the system prompt's `<date>` section.
 *
 * When a test provider is installed, its decision is authoritative: returning a valid calendar date pins `<date>`
 * without altering `Date.now()`, while returning `undefined` (for example when a test explicitly installs fake `Date`
 * timers) falls straight through to `new Date()` without reading the child-process environment variable. Outside test
 * workers, a valid `ATOMIC_TEST_SYSTEM_PROMPT_DATE` environment value pins `<date>` for spawned test children; in
 * ordinary production runs neither is set and the live local calendar date is returned.
 */
export function currentSystemPromptDate(now?: Date): string {
	if (now === undefined) {
		const provider = (globalThis as SystemPromptDateSlot)[SYSTEM_PROMPT_DATE_PROVIDER];
		if (provider !== undefined) {
			const resolved = provider();
			if (isCalendarDate(resolved)) return resolved;
			return formatLocalCalendarDate(new Date());
		}
		const envDate = process.env[SYSTEM_PROMPT_DATE_ENV];
		if (isCalendarDate(envDate)) return envDate;
	}
	return formatLocalCalendarDate(now ?? new Date());
}
