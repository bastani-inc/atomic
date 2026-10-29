import { randomUUID } from "node:crypto";

/**
 * Names this process, for fixtures that must tell one worker process from the next. A pid cannot: an operating system
 * may hand a dead process's pid to its replacement (Windows does so within moments), while a fresh process always draws
 * a fresh instance id. The id lives on `globalThis` so every copy of this module a process loads (the worker loads
 * fixtures through its own module loader) reports the same one.
 */
const KEY = Symbol.for("atomic.test.processInstance");
const holder = globalThis as { [KEY]?: string };

export const processInstance: string = (holder[KEY] ??= randomUUID());

/** Which process ran a step: its pid, for humans and replay checks, and its instance id, for telling processes apart. */
export function processIdentity(): { readonly pid: number; readonly instance: string } {
	return { pid: process.pid, instance: processInstance };
}
