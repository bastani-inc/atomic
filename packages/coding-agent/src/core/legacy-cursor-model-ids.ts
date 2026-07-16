import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { isAuthenticatedCursorRouteModel } from "./cursor-model-reference.ts";

/**
 * Cursor exposes no static executable catalog: GetUsable is the sole authority.
 * A bare (non-qualified) model reference is therefore only a current Cursor route
 * when a live GetUsable row for the exact lowercase `cursor` provider matches it;
 * otherwise it is an ordinary reference resolved by the generic (non-Cursor)
 * matchers. No rejection-only historical id list is retained.
 */
export type BareCursorModelReferenceKind = "current-cursor" | "other";

export interface CursorModelIdentity {
	readonly provider: string;
	readonly id: string;
	readonly api: string;
	readonly compat?: Model<Api>["compat"];
}

export function classifyBareCursorModelReference(
	rawInput: string,
	models: readonly CursorModelIdentity[],
): BareCursorModelReferenceKind {
	if (rawInput.includes("/")) return "other";
	return models.some((model) => isAuthenticatedCursorRouteModel(model) && model.id === rawInput)
		? "current-cursor"
		: "other";
}
