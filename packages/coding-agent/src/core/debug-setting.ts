import { DebugConfigError, type DebugSettingSource } from "./debug-errors.ts";

/** Carries the `debug` setting into child processes. Atomic sets it; users set `ATOMIC_DEBUG`. */
export const DEBUG_SETTING_ENV = "ATOMIC_DEBUG_SETTING";

let debugSetting = process.env[DEBUG_SETTING_ENV] === "1";
const settingListeners = new Set<(enabled: boolean) => void>();

/** This process's `debug` setting: its saved value, a toggle in `/settings`, or what its parent passed down. */
export function isDebugSettingOn(): boolean {
	return debugSetting;
}

/**
 * Sets this process's `debug` setting. Child processes started afterwards inherit it. Throws {@link DebugConfigError},
 * changing nothing, when `enabled` is not a boolean.
 */
export function setDebugSetting(enabled: boolean, source: DebugSettingSource = "sdk"): void {
	if (typeof enabled !== "boolean") throw new DebugConfigError(source, enabled);
	if (enabled === debugSetting) return;
	debugSetting = enabled;
	for (const listener of settingListeners) listener(enabled);
}

/** Calls `listener` whenever this process's `debug` setting changes; returns the unsubscribe function. */
export function onDebugSettingChange(listener: (enabled: boolean) => void): () => void {
	settingListeners.add(listener);
	return () => settingListeners.delete(listener);
}

/** Writes this process's `debug` setting into `env`, the environment of a child process about to start. */
export function applyDebugSettingToChildEnvironment(env: NodeJS.ProcessEnv): void {
	if (debugSetting) env[DEBUG_SETTING_ENV] = "1";
	else delete env[DEBUG_SETTING_ENV];
}
