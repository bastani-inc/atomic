import { runtimeIntercomGroupEnvKey } from "@bastani/atomic";

export { runtimeIntercomGroupEnvKey } from "@bastani/atomic";

/** Register one extension instance's current runtime group for child inheritance. */
export function setRuntimeIntercomGroup(sessionId: string, group: string): void {
	process.env[runtimeIntercomGroupEnvKey(sessionId)] = group;
}

/** Remove one extension instance's runtime group without clobbering another session. */
export function clearRuntimeIntercomGroup(sessionId: string): void {
	delete process.env[runtimeIntercomGroupEnvKey(sessionId)];
}
