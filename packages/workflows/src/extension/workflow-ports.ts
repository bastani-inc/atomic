import { isStaleExtensionContextError } from "@bastani/atomic";
import type { WorkflowMcpPort, WorkflowPersistencePort } from "../shared/types.js";
import { clearMcpScope, type PiEventBus, type PiMcpExtensionAPI, setMcpScope } from "./mcp.js";
import type { ExtensionAPI } from "./public-types.js";

/**
 * A workflow can outlive its extension instance: `/reload` invalidates the
 * predecessor's API while its module graph keeps executing this run. A
 * transcript entry from that orphaned graph is advisory — the successor's
 * observers report the run's state — and must not fail the run, so exactly
 * the staleness rejection is swallowed here; every other error still throws.
 */
function unlessStale<T>(append: () => T): T | undefined {
	try {
		return append();
	} catch (error) {
		if (isStaleExtensionContextError(error)) return undefined;
		throw error;
	}
}

export function makePersistencePort(pi: ExtensionAPI, persistRuns: boolean): WorkflowPersistencePort | undefined {
	if (!persistRuns) return undefined;
	if (typeof pi.appendEntry !== "function") return undefined;
	const port: WorkflowPersistencePort = {
		appendEntry: (type, payload) => unlessStale(() => pi.appendEntry!(type, payload)),
	};
	if (typeof pi.setLabel === "function") {
		port.setLabel = (entryId, label) => {
			unlessStale(() => pi.setLabel!(entryId, label));
		};
	}
	if (typeof pi.appendCustomMessageEntry === "function") {
		port.appendCustomMessageEntry = (content, meta) => unlessStale(() => pi.appendCustomMessageEntry!(content, meta));
	}
	return port;
}

export function makeMcpPort(pi: ExtensionAPI): WorkflowMcpPort | undefined {
	if (typeof pi.events?.emit !== "function") return undefined;
	const piForMcp: PiMcpExtensionAPI = {
		events: { emit: pi.events.emit as PiEventBus["emit"] },
	};
	return {
		setScope(stageId: string, allow: string[] | null, deny: string[] | null) {
			try {
				setMcpScope(piForMcp, {
					stageId,
					allow: allow ?? undefined,
					deny: deny ?? undefined,
				});
			} catch {
				// A workflow can outlive its extension instance; scope events are advisory.
			}
		},
		clearScope(stageId: string) {
			try {
				clearMcpScope(piForMcp, stageId);
			} catch {
				// A workflow can outlive its extension instance; scope events are advisory.
			}
		},
	};
}
