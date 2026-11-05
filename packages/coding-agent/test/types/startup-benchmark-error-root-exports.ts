import type {
	isStartupBenchmarkConfigError,
	StartupBenchmarkConfigError,
	StartupBenchmarkErrorCode,
	StartupBenchmarkUnsupportedMode,
} from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;

export type StartupBenchmarkErrorCodeRootExport = Assert<Equal<StartupBenchmarkErrorCode, "unsupported-mode">>;
export type StartupBenchmarkUnsupportedModeRootExport = Assert<
	Equal<StartupBenchmarkUnsupportedMode, "print" | "json" | "rpc">
>;
export type StartupBenchmarkConfigErrorFieldsRootExport = Assert<
	Equal<
		Pick<StartupBenchmarkConfigError, "code" | "source" | "appMode">,
		{ readonly code: "unsupported-mode"; readonly source: "env"; readonly appMode: StartupBenchmarkUnsupportedMode }
	>
>;
export type StartupBenchmarkConfigGuardRootExport = Assert<
	Equal<typeof isStartupBenchmarkConfigError, (error: unknown) => error is StartupBenchmarkConfigError>
>;
