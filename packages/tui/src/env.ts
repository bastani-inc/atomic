/**
 * The value of a renderer setting from the environment: `ATOMIC_<name>` when set, else the legacy `PI_<name>`.
 */
export function getTuiEnvValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[`ATOMIC_${name}`] ?? env[`PI_${name}`];
}
