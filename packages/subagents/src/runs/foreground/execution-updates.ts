import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../../shared/types.ts";
import { isRetryableModelFailure } from "../shared/model-fallback.ts";
import { isStructuredOutputContractError } from "../shared/structured-output.ts";

export type RunSyncUpdate = AgentToolResult<Details>;

function extractUpdateText(update: RunSyncUpdate): string | undefined {
	const text = update.content
		.map((item) => item.type === "text" ? item.text : undefined)
		.filter((item): item is string => Boolean(item?.trim()))
		.join("\n");
	return text || undefined;
}

function terminalUpdateFailureText(update: RunSyncUpdate): string | undefined {
	const result = update.details?.results?.[0];
	if (!result) return undefined;
	const progress = update.details?.progress?.[0];
	const status = result.progress?.status ?? progress?.status;
	if (status !== "failed") return undefined;
	return result.error
		?? result.progress?.error
		?? progress?.error
		?? extractUpdateText(update);
}

export function shouldSuppressIntermediateRetryableFailureUpdate(update: RunSyncUpdate): boolean {
	return isRetryableModelFailure(terminalUpdateFailureText(update));
}

export function shouldSuppressIntermediateStructuredOutputFailureUpdate(update: RunSyncUpdate): boolean {
	return isStructuredOutputContractError(terminalUpdateFailureText(update));
}
