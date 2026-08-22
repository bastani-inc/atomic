import { PARENT_ASK_PAUSE_REQUEST_EVENT, type ParentAskPauseRequest, type RunSyncOptions } from "../../shared/types.js";

interface ExecutionParentAskState {
	readonly agent: string;
	readonly isUnavailable: () => boolean;
}

const PROCESS_PARENT_ASK_CLAIMS = Symbol.for("atomic/subagents/parent-ask-claims@1");

type ProcessParentAskClaimHandler = (payload: unknown) => void;

interface ProcessParentAskClaimRegistry {
	handlers: Set<ProcessParentAskClaimHandler>;
}

function processClaimSlots(): typeof globalThis & Record<symbol, ProcessParentAskClaimRegistry | undefined> {
	return globalThis as typeof globalThis & Record<symbol, ProcessParentAskClaimRegistry | undefined>;
}

function registerProcessClaimHandler(handler: ProcessParentAskClaimHandler): () => void {
	const slots = processClaimSlots();
	const registry = slots[PROCESS_PARENT_ASK_CLAIMS] ?? { handlers: new Set<ProcessParentAskClaimHandler>() };
	slots[PROCESS_PARENT_ASK_CLAIMS] = registry;
	registry.handlers.add(handler);
	return () => {
		registry.handlers.delete(handler);
		if (registry.handlers.size === 0 && slots[PROCESS_PARENT_ASK_CLAIMS] === registry) {
			delete slots[PROCESS_PARENT_ASK_CLAIMS];
		}
	};
}

function isParentAskPauseRequest(payload: unknown): payload is ParentAskPauseRequest {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const request = payload as Partial<ParentAskPauseRequest>;
	return (
		typeof request.runId === "string" &&
		typeof request.index === "number" &&
		typeof request.agent === "string" &&
		typeof request.childIntercomTarget === "string" &&
		typeof request.orchestratorTarget === "string" &&
		(request.kind === "decision" || request.kind === "interview" || request.kind === "intercom") &&
		typeof request.question === "string" &&
		typeof request.claimed === "boolean"
	);
}

/** Claim a blocking ask only for the exact live child attempt that issued it. */
export function registerExecutionParentAskPause(options: RunSyncOptions, state: ExecutionParentAskState): () => void {
	if (!options.onParentAskClaim) return () => {};
	const handleRequest = (payload: unknown): void => {
		if (state.isUnavailable() || !isParentAskPauseRequest(payload)) return;
		if (
			payload.claimed ||
			payload.runId !== options.runId ||
			payload.index !== (options.index ?? 0) ||
			payload.agent !== state.agent ||
			payload.childIntercomTarget !== options.intercomSessionName ||
			payload.orchestratorTarget !== options.orchestratorIntercomTarget
		)
			return;
		payload.claimed = true;
		options.onParentAskClaim?.(payload);
	};
	const eventCleanup = options.intercomEvents?.on(PARENT_ASK_PAUSE_REQUEST_EVENT, handleRequest) ?? (() => {});
	const processCleanup = registerProcessClaimHandler(handleRequest);
	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		eventCleanup();
		processCleanup();
	};
}
