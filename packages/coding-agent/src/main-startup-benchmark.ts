import { APP_NAME, ENV_STARTUP_BENCHMARK, ENV_TIMING, getEnvValue } from "./config.js";
import type { AgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type ErrorFieldValue,
	hasErrorIdentity,
	rehydrateErrorCause,
	type SerializedTypedError,
	serializeErrorCause,
} from "./core/error-contract.ts";
import { printTimings, time } from "./core/timings.ts";
import type { AppMode } from "./main-app-mode.ts";
import { isTruthyEnvFlag } from "./main-stdio.ts";
import type { InteractiveMode } from "./modes/interactive/interactive-mode.ts";
import { IsolatedInteractiveRuntime } from "./modes/interactive-engine/isolated-runtime.js";
import type { InteractiveEngineStartupEnv } from "./utils/interactive-engine-env.ts";

/** Stable codes of StartupBenchmarkError. Codes are public API: never rename or reuse one. */
export type StartupBenchmarkErrorCode = "unsupported-mode";

/** The app modes the startup benchmark cannot measure. */
export type StartupBenchmarkUnsupportedMode = Exclude<AppMode, "interactive">;

const STARTUP_BENCHMARK_ERROR_CODES: ReadonlySet<string> = new Set<StartupBenchmarkErrorCode>(["unsupported-mode"]);
const STARTUP_BENCHMARK_CONFIG_NAMES: ReadonlySet<string> = new Set(["StartupBenchmarkConfigError"]);
const STARTUP_BENCHMARK_ERROR_NAMES: ReadonlySet<string> = new Set([
	"StartupBenchmarkError",
	"StartupBenchmarkConfigError",
]);
const UNSUPPORTED_MODES: ReadonlySet<ErrorFieldValue> = new Set<ErrorFieldValue>([
	"print",
	"json",
	"rpc",
] satisfies StartupBenchmarkUnsupportedMode[]);

/** The startup benchmark could not run. Branch on `code` or the class. */
export class StartupBenchmarkError extends Error {
	override readonly name: string = "StartupBenchmarkError";
	readonly code: StartupBenchmarkErrorCode;
	readonly hint: string | undefined;
	readonly retryable: boolean;

	constructor(
		message: string,
		options: { code: StartupBenchmarkErrorCode; hint?: string; retryable: boolean; cause?: unknown },
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.code = options.code;
		this.hint = options.hint;
		this.retryable = options.retryable;
	}

	/** The JSON-safe facts beyond the name, code, message and hint. */
	get fields(): Record<string, ErrorFieldValue> {
		return {};
	}

	toJSON(): SerializedTypedError {
		const cause = serializeErrorCause(this.cause);
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			...(this.hint === undefined ? {} : { hint: this.hint }),
			retryable: this.retryable,
			fields: this.fields,
			...(cause ? { cause } : {}),
		};
	}
}

/**
 * `ATOMIC_STARTUP_BENCHMARK` is set for a process that has no interactive session to measure: print mode, JSON
 * mode, or a standalone RPC server. Thrown before any runtime is created.
 */
export class StartupBenchmarkConfigError extends StartupBenchmarkError {
	override readonly name = "StartupBenchmarkConfigError" as const;
	declare readonly code: "unsupported-mode";
	readonly source = "env" as const;
	readonly field: string;
	readonly appMode: StartupBenchmarkUnsupportedMode;

	constructor(options: { appMode: StartupBenchmarkUnsupportedMode; field?: string }) {
		const field = options.field ?? ENV_STARTUP_BENCHMARK;
		const hint = `${field} measures interactive startup only. Unset it, or start ${APP_NAME} in a terminal without --print, --mode or piped input.`;
		super(
			`Invalid startup benchmark configuration: ${field} in ${options.appMode} mode (unsupported-mode). ${hint}`,
			{
				code: "unsupported-mode",
				hint,
				retryable: false,
			},
		);
		this.field = field;
		this.appMode = options.appMode;
	}

	override get fields(): Record<string, ErrorFieldValue> {
		return { source: this.source, field: this.field, appMode: this.appMode };
	}
}

/** Whether `error` is a StartupBenchmarkError, also from another realm or a rehydrated relay. */
export function isStartupBenchmarkError(error: unknown): error is StartupBenchmarkError {
	return (
		error instanceof StartupBenchmarkError ||
		hasErrorIdentity(error, STARTUP_BENCHMARK_ERROR_NAMES, STARTUP_BENCHMARK_ERROR_CODES)
	);
}

/** Whether `error` is a StartupBenchmarkConfigError, also from another realm or a rehydrated relay. */
export function isStartupBenchmarkConfigError(error: unknown): error is StartupBenchmarkConfigError {
	return (
		error instanceof StartupBenchmarkConfigError ||
		hasErrorIdentity(error, STARTUP_BENCHMARK_CONFIG_NAMES, STARTUP_BENCHMARK_ERROR_CODES)
	);
}

/** Rebuilds a serialized StartupBenchmarkError; an unknown name becomes the family base with its name and code kept. */
export function rehydrateStartupBenchmarkError(serialized: SerializedTypedError): StartupBenchmarkError {
	const { fields } = serialized;
	if (
		serialized.name === "StartupBenchmarkConfigError" &&
		UNSUPPORTED_MODES.has(fields.appMode) &&
		typeof fields.field === "string"
	) {
		return new StartupBenchmarkConfigError({
			appMode: fields.appMode as StartupBenchmarkUnsupportedMode,
			field: fields.field,
		});
	}
	const error = new StartupBenchmarkError(serialized.message, {
		code: serialized.code as StartupBenchmarkErrorCode,
		hint: serialized.hint,
		retryable: serialized.retryable,
		cause: rehydrateErrorCause(serialized.cause),
	});
	Object.defineProperty(error, "name", { value: serialized.name });
	return error;
}

/**
 * Whether this process runs the startup benchmark. An isolated interactive engine never does: it inherits the
 * host's environment, and the host measures the interactive session, engine startup included (#4354).
 *
 * @throws StartupBenchmarkConfigError when the benchmark is requested outside interactive mode.
 */
export function resolveStartupBenchmark(
	appMode: AppMode,
	engineEnv: Pick<InteractiveEngineStartupEnv, "child">,
	value: string | undefined = getEnvValue(ENV_STARTUP_BENCHMARK),
): boolean {
	if (engineEnv.child === "1" || !isTruthyEnvFlag(value)) return false;
	if (appMode !== "interactive") throw new StartupBenchmarkConfigError({ appMode });
	return true;
}

/**
 * Environment overrides for the isolated engine of a host that runs the startup benchmark. The host prints the
 * session's timings once; the engine inherits the timing switch, so without this its own block would reach the
 * terminal through its relayed stderr as a second one (#4354).
 */
export function startupBenchmarkEngineEnv(
	value: string | undefined = getEnvValue(ENV_STARTUP_BENCHMARK),
): Record<string, string> {
	return isTruthyEnvFlag(value) ? { [ENV_TIMING]: "0" } : {};
}

/** The startup timing hooks the benchmark records into and prints. */
export interface StartupBenchmarkTimings {
	time(label: string): void;
	printTimings(): void;
}

/**
 * Run the interactive session's startup to the point a user could type, then end it through the same teardown as a
 * quit, printing the timings once in between: after the TUI has left the alternate screen, so they stay on the
 * terminal, and before the runtime is disposed, so engine shutdown is not counted. Under the isolated engine that
 * point is the engine's resources being loaded, so the engine's extensions have started and get `session_shutdown`.
 * A failed startup is torn down the same way and its error rethrown, with a teardown failure attached as
 * `cleanupCause`.
 */
export async function measureInteractiveStartup(
	mode: Pick<InteractiveMode, "init" | "ensureDeferredStartupComplete" | "stop">,
	runtime: Pick<AgentSessionRuntime, "dispose">,
	timings: StartupBenchmarkTimings = { time, printTimings },
): Promise<void> {
	try {
		await mode.init();
		timings.time("interactiveMode.init");
		await mode.ensureDeferredStartupComplete();
		if (runtime instanceof IsolatedInteractiveRuntime) {
			await runtime.waitUntilResourcesReady();
			timings.time("interactiveEngine.resourcesReady");
		}
	} catch (error) {
		try {
			mode.stop();
			await runtime.dispose();
		} catch (cleanupCause) {
			throw withCleanupCause(error, cleanupCause);
		}
		throw error;
	}
	mode.stop();
	timings.printTimings();
	await runtime.dispose();
}

function withCleanupCause(primary: unknown, cleanupCause: unknown): unknown {
	if (!(primary instanceof Error)) {
		return new AggregateError([primary, cleanupCause], "Startup benchmark failed, and so did its teardown");
	}
	return Object.assign(primary, { cleanupCause });
}
