/**
 * The environment for a Windows PowerShell (`powershell.exe`, 5.1) process Atomic starts for its own work. A PowerShell
 * 7 parent, such as a `pwsh` terminal Atomic was started from, puts its own module directories in `PSModulePath`.
 * Windows PowerShell then finds PowerShell 7's copies of its built-in modules first and fails to load them, so any
 * cmdlet whose module loads on demand (`Get-Process`, `Get-Acl`, `Get-CimInstance`, `Expand-Archive`, ...) fails with
 * "the module could not be loaded". Without the variable each host uses its own default module path.
 */
export function windowsPowerShellEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() !== "psmodulepath") result[key] = value;
	}
	return result;
}
