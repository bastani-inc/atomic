import {
	formatLocalCalendarDate,
	isCalendarDate,
	SYSTEM_PROMPT_DATE_ENV,
	type SystemPromptDateProvider,
	setSystemPromptDateProviderForTest,
} from "../../packages/coding-agent/src/core/system-prompt-date.js";

export interface SystemPromptDateIsolationHandle {
	readonly pinnedDate: string;
	readonly provider: SystemPromptDateProvider;
	restore(): void;
}

/**
 * Pin the system prompt's `<date>` section to one calendar day per test worker so midnight rollovers never inject
 * unexpected `<date>` system updates mid-test, while leaving `Date.now()` untouched (no wall-clock skew against
 * SQLite, filesystem mtimes, or timers).
 *
 * When a test explicitly replaces `globalThis.Date` (for example with `vi.useFakeTimers({ toFake: ["Date"] })` and
 * `vi.setSystemTime(...)`), the provider returns `undefined` so `currentSystemPromptDate()` follows the test's fake
 * `Date` directly without reading `ATOMIC_TEST_SYSTEM_PROMPT_DATE`.
 *
 * Also publishes the pinned date in `ATOMIC_TEST_SYSTEM_PROMPT_DATE` so spawned child processes (CLI, isolated engine,
 * and subagents) share the same calendar day unless a test explicitly clears or overrides that variable.
 */
export function installSystemPromptDateIsolation(
	hooks?: { readonly beforeEach: (fn: () => void) => void },
	options?: { readonly realDate?: DateConstructor; readonly env?: NodeJS.ProcessEnv },
): SystemPromptDateIsolationHandle {
	const realDate = options?.realDate ?? globalThis.Date;
	const env = options?.env ?? process.env;
	const hadEnv = Object.hasOwn(env, SYSTEM_PROMPT_DATE_ENV);
	const previousEnv = env[SYSTEM_PROMPT_DATE_ENV];
	const inherited = env[SYSTEM_PROMPT_DATE_ENV];
	const pinnedDate = isCalendarDate(inherited) ? inherited : formatLocalCalendarDate(new realDate());
	const provider: SystemPromptDateProvider = () => (globalThis.Date === realDate ? pinnedDate : undefined);
	const previousProvider = setSystemPromptDateProviderForTest(provider);
	env[SYSTEM_PROMPT_DATE_ENV] = pinnedDate;

	hooks?.beforeEach(() => {
		setSystemPromptDateProviderForTest(provider);
		env[SYSTEM_PROMPT_DATE_ENV] = pinnedDate;
	});

	return {
		pinnedDate,
		provider,
		restore() {
			setSystemPromptDateProviderForTest(previousProvider);
			if (hadEnv) env[SYSTEM_PROMPT_DATE_ENV] = previousEnv;
			else delete env[SYSTEM_PROMPT_DATE_ENV];
		},
	};
}

/**
 * Forward the worker's pinned system-prompt date into a child process's explicit environment unless the caller already
 * named `ATOMIC_TEST_SYSTEM_PROMPT_DATE` (including setting it to `""` or `undefined` to opt out).
 */
export function withTestSystemPromptDate<T extends Record<string, string | undefined>>(
	env: T,
	sourceEnv: NodeJS.ProcessEnv = process.env,
): T {
	if (Object.hasOwn(env, SYSTEM_PROMPT_DATE_ENV)) return env;
	const pinned = sourceEnv[SYSTEM_PROMPT_DATE_ENV];
	if (!isCalendarDate(pinned)) return env;
	return { ...env, [SYSTEM_PROMPT_DATE_ENV]: pinned };
}
