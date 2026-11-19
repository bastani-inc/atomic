import type { SubagentToolResult } from "../../shared/types.js";

interface BurstDisplay {
	ownerId: string;
	callIds: string[];
	taskCount: number;
	result?: SubagentToolResult;
}

const MAX_RETAINED_BURST_DISPLAYS = 100;
const displays: BurstDisplay[] = [];
const displayByCallId = new Map<string, BurstDisplay>();

export interface BurstDisplaySnapshot {
	owner: boolean;
	taskCount: number;
	result?: SubagentToolResult;
}

export function registerBurstDisplay(callIds: string[], taskCount: number): BurstDisplay {
	const display: BurstDisplay = { ownerId: callIds[0]!, callIds, taskCount };
	displays.push(display);
	for (const callId of callIds) displayByCallId.set(callId, display);
	while (displays.length > MAX_RETAINED_BURST_DISPLAYS) {
		const expired = displays.shift();
		if (!expired) break;
		for (const callId of expired.callIds) {
			if (displayByCallId.get(callId) === expired) displayByCallId.delete(callId);
		}
	}
	return display;
}

/** Forgets a burst whose merged run never ran, so each of its calls renders as its own again. */
export function releaseBurstDisplay(display: BurstDisplay): void {
	const index = displays.indexOf(display);
	if (index >= 0) displays.splice(index, 1);
	for (const callId of display.callIds) {
		if (displayByCallId.get(callId) === display) displayByCallId.delete(callId);
	}
}

export function updateBurstDisplay(display: BurstDisplay, result: SubagentToolResult): void {
	display.result = result;
}

export function getBurstDisplay(callId: string): BurstDisplaySnapshot | undefined {
	const display = displayByCallId.get(callId);
	if (!display) return undefined;
	return {
		owner: display.ownerId === callId,
		taskCount: display.taskCount,
		...(display.result ? { result: display.result } : {}),
	};
}
