import { BROKER_SOCKET_PATH_ENV } from "./paths.js";

const STRIPPED_HOST_COMMAND_ENV_KEYS = new Set(["psmodulepath", BROKER_SOCKET_PATH_ENV.toLowerCase()]);

/**
 * The environment for a host command. Windows PowerShell started from a PowerShell 7 parent inherits PowerShell 7's
 * `PSModulePath`, finds PowerShell 7's copies of its built-in modules first and fails to load them, so `Get-Process`
 * and `Get-CimInstance` fail. Without the variable Windows PowerShell uses its own module path; the other host commands
 * do not read it. Also strips {@link BROKER_SOCKET_PATH_ENV} so broker-spawned host commands never inherit the
 * spawner's pipe-name handoff variable.
 */
export function hostCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (!STRIPPED_HOST_COMMAND_ENV_KEYS.has(key.toLowerCase())) result[key] = value;
	}
	return result;
}
