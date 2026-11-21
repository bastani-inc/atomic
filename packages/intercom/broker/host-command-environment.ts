/**
 * The environment for a host command. Windows PowerShell started from a PowerShell 7 parent inherits PowerShell 7's
 * `PSModulePath`, finds PowerShell 7's copies of its built-in modules first and fails to load them, so `Get-Process`
 * and `Get-CimInstance` fail. Without the variable Windows PowerShell uses its own module path; the other host commands
 * do not read it.
 */
export function hostCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() !== "psmodulepath") result[key] = value;
	}
	return result;
}
