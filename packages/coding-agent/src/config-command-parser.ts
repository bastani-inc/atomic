export interface ConfigCommandOptions {
	local: boolean;
	help: boolean;
	projectTrustOverride?: boolean;
	invalidOption?: string;
	invalidArgument?: string;
}

export function parseConfigCommand(args: readonly string[]): ConfigCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "config") return undefined;
	const result: ConfigCommandOptions = { local: false, help: false };
	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") result.help = true;
		else if (arg === "-l" || arg === "--local") result.local = true;
		else if (arg === "-a" || arg === "--approve") result.projectTrustOverride = true;
		else if (arg === "-na" || arg === "--no-approve") result.projectTrustOverride = false;
		else if (arg.startsWith("-")) result.invalidOption ??= arg;
		else result.invalidArgument ??= arg;
	}
	return result;
}
