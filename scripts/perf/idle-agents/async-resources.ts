/**
 * Live timers, sockets and processes of this thread, counted with `async_hooks`. `process.getActiveResourcesInfo()`
 * cannot be used for this: it leaves out an unref'd timer or socket, which is what most of Atomic's timers are, so it
 * would report zero for exactly the resources an idle agent must not keep.
 */
import { createHook } from "node:async_hooks";

const TRACKED_TYPES: ReadonlySet<string> = new Set([
	"Timeout",
	"TCPWRAP",
	"TCPSERVERWRAP",
	"PIPEWRAP",
	"TLSWRAP",
	"UDPWRAP",
	"PROCESSWRAP",
	"FSEVENTWRAP",
	"SIGNALWRAP",
]);

const live = new Map<number, string>();
const hook = createHook({
	init(asyncId, type) {
		if (TRACKED_TYPES.has(type)) live.set(asyncId, type);
	},
	destroy(asyncId) {
		live.delete(asyncId);
	},
});

/** Start counting. Resources created before this call are not counted, so take a baseline right after it. */
export function trackAsyncResources(): () => void {
	hook.enable();
	return () => {
		hook.disable();
		live.clear();
	};
}

/** The tracked resources alive now, by async type. */
export function liveAsyncResources(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const type of live.values()) counts[type] = (counts[type] ?? 0) + 1;
	return counts;
}
