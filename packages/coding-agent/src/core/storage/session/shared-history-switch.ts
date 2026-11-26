import type { SessionOpenMarkerAge } from "./types.js";

/**
 * How a session store's open decides about the switch to shared-history forks (#6560): whether a session an older
 * Atomic marked open is still running, and where a skipped switch is noted. The application sets them once, with its
 * own judge of a marker's process and its debug log; without it, a marker counts while its heartbeat is younger than
 * {@link MARKER_HEARTBEAT_STALE_MS}, as another host's does, and nothing is noted.
 */
export interface SharedHistorySwitchHost {
	/** Whether the process that keeps `marker` still runs. */
	live(marker: SessionOpenMarkerAge): Promise<boolean>;
	/** Notes, for debugging only, why an open left the switch for a later one. */
	skipped(fields: Readonly<Record<string, string | number>>): void;
}

/** How old a marker's heartbeat may be while its process counts as running: four of its 15-second refreshes. */
export const MARKER_HEARTBEAT_STALE_MS = 60_000;

let host: SharedHistorySwitchHost = {
	live: async (marker) => marker.ageMs <= MARKER_HEARTBEAT_STALE_MS,
	skipped: () => {},
};

export function setSharedHistorySwitchHost(next: SharedHistorySwitchHost): void {
	host = next;
}

export function sharedHistorySwitchHost(): SharedHistorySwitchHost {
	return host;
}
