import {
	BASH_SHELL_PRESENTATION,
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	getPowerShellConfig,
	isPowerShellToolResult,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolCallEvent,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
	type ShellToolPresentation,
} from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;

export type PowerShellToolCallEventRootExport = Assert<Equal<PowerShellToolCallEvent["toolName"], "powershell">>;
export type PowerShellToolInputRootExport = Assert<Equal<PowerShellToolInput["command"], string>>;
export type PowerShellSpawnContextRootExport = Assert<Equal<PowerShellSpawnContext["command"], string>>;
export type ShellToolPresentationRootExport = Assert<Equal<ShellToolPresentation["prompt"], string>>;

export const powerShellRootFactories = {
	BASH_SHELL_PRESENTATION,
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	getPowerShellConfig,
	isPowerShellToolResult,
};

export type PowerShellRootTypes = {
	operations: PowerShellOperations;
	spawnHook: PowerShellSpawnHook;
	details: PowerShellToolDetails;
	options: PowerShellToolOptions;
};
