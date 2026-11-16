import type { QuestionData } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";

export type RowKind = WrappingSelectItem["kind"];

/**
 * Sentinel kinds — the subset of `RowKind` representing protocol-driven rows
 * (vs author-defined `option` rows). The auto-append walker, the reserved-label
 * derivation, and `LABELS_BY_KIND` consumers iterate this list.
 */
export type SentinelKind = Exclude<RowKind, "option">;
export const SENTINEL_KINDS: readonly SentinelKind[] = ["other", "chat", "next"];

export interface RowIntentMeta {
	label: string;
	reserved: boolean;
	livesInMainList: boolean;
	numbered: boolean;
	activatesInputMode: boolean;
	blocksMultiToggle: boolean;
	autoSubmitsInMulti: boolean;
	autoAppendOnSingleSelectNoPreview: boolean;
	autoAppendOnMultiSelect: boolean;
}

export const ROW_INTENT_META: Record<RowKind, RowIntentMeta> = {
	option: {
		label: "",
		reserved: false,
		livesInMainList: true,
		numbered: true,
		activatesInputMode: false,
		blocksMultiToggle: false,
		autoSubmitsInMulti: false,
		autoAppendOnSingleSelectNoPreview: false,
		autoAppendOnMultiSelect: false,
	},
	other: {
		label: "Type something.",
		reserved: true,
		livesInMainList: true,
		numbered: true,
		activatesInputMode: true,
		blocksMultiToggle: false,
		autoSubmitsInMulti: false,
		autoAppendOnSingleSelectNoPreview: true,
		autoAppendOnMultiSelect: false,
	},
	chat: {
		label: "Chat about this",
		reserved: true,
		livesInMainList: false,
		numbered: true,
		activatesInputMode: true,
		blocksMultiToggle: false,
		autoSubmitsInMulti: false,
		autoAppendOnSingleSelectNoPreview: false,
		autoAppendOnMultiSelect: false,
	},
	next: {
		label: "Next",
		reserved: true,
		livesInMainList: true,
		numbered: true,
		activatesInputMode: false,
		blocksMultiToggle: true,
		autoSubmitsInMulti: true,
		autoAppendOnSingleSelectNoPreview: false,
		autoAppendOnMultiSelect: true,
	},
};

/**
 * Kind-keyed label view. `option` is excluded — its label is per-instance,
 * not per-kind. `types.ts#SENTINEL_LABELS` re-sources from here.
 */
export const LABELS_BY_KIND: { readonly [K in SentinelKind]: string } = {
	other: ROW_INTENT_META.other.label,
	chat: ROW_INTENT_META.chat.label,
	next: ROW_INTENT_META.next.label,
};

/**
 * Reserved-label set for runtime validation. Includes "Other" (a model-conditioned
 * label that has no runtime kind) plus every sentinel with `reserved: true`.
 */
export const RESERVED_LABEL_SET: ReadonlySet<string> = new Set<string>([
	"Other",
	...SENTINEL_KINDS.filter((k) => ROW_INTENT_META[k].reserved).map((k) => ROW_INTENT_META[k].label),
]);

/**
 * Walk the META table to synthesize sentinel rows for one question. The two
 * append predicates are mutually exclusive in practice (`multiSelect` vs
 * `!multiSelect && !hasAnyPreview`) but the walker doesn't enforce that —
 * adding a third bucket only requires a new META flag.
 *
 * Returns sentinel descriptors in declaration order of `SENTINEL_KINDS`. The
 * caller wraps each with the `WrappingSelectItem` shape (kind + label).
 */
export function sentinelsToAppend(question: QuestionData, hasAnyPreview: boolean): SentinelKind[] {
	const out: SentinelKind[] = [];
	for (const k of SENTINEL_KINDS) {
		const meta = ROW_INTENT_META[k];
		if (!meta.livesInMainList) continue;
		if (question.multiSelect === true) {
			if (meta.autoAppendOnMultiSelect) out.push(k);
		} else {
			if (meta.autoAppendOnSingleSelectNoPreview && !hasAnyPreview) out.push(k);
		}
	}
	return out;
}
