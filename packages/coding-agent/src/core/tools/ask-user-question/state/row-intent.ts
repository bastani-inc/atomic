import type { QuestionData } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";

/**
 * Row kind discriminator. Single source of truth — derived from the runtime
 * `WrappingSelectItem` union (`wrapping-select.ts:18-22`) so adding a new
 * variant there forces a `ROW_INTENT_META` entry here (compile-time
 * exhaustiveness via `Record<RowKind, …>`).
 */
export type RowKind = WrappingSelectItem["kind"];

/**
 * Sentinel kinds — the subset of `RowKind` representing protocol-driven rows
 * (vs author-defined `option` rows). The auto-append walker, the reserved-label
 * derivation, and `LABELS_BY_KIND` consumers iterate this list.
 */
export type SentinelKind = Exclude<RowKind, "option">;
export const SENTINEL_KINDS: readonly SentinelKind[] = ["other", "chat", "next"];

/**
 * Per-kind static metadata. Pure data — no closures, no per-kind handler
 * functions. Behavior-bearing branches (answer construction in
 * `key-router.ts:69-99`, the Next-row render block in `multi-select-view.ts`,
 * and the inline-Input render branch in `wrapping-select.ts`) keep their
 * exhaustive switches and READ flags from this table.
 *
 * Adding a new sentinel:
 *   1. Add the variant to `WrappingSelectItem` (`wrapping-select.ts:18-22`).
 *   2. Add an entry here. Compile fails until both edits are present.
 *   3. (If user-facing) author wherever the row is synthesized — typically
 *      `buildItemsForQuestion` for main-list residents, or the `chatList`
 *      construction site for non-main-list rows.
 *
 * Field semantics:
 * - `label` — user-facing string. For `option` it's an empty placeholder
 *   (per-instance labels come from `QuestionData.options[i].label`); every
 *   sentinel uses its META entry as the single source of truth.
 * - `reserved` — author-facing labels matching this string trigger
 *   `reserved_label` at validation time. `RESERVED_LABEL_SET` is derived.
 * - `livesInMainList` — true iff the row appears in `itemsByTab[i]`. Chat
 *   lives in its own `chatList` (`questionnaire-session.ts:95`) so its row
 *   never enters the main list.
 * - `numbered` — true iff the row contributes to the main-list numbering
 *   offset that `chatNumberingFor` reads. Multi-select Next is the only
 *   numberable=false row that lives in the list; chat is numbered=true but
 *   `livesInMainList=false` so the flag is moot for chat.
 * - `activatesInputMode` — true iff focusing the row should toggle
 *   `state.inputMode = true` and hydrate that row's shared inline-input
 *   owner. Read by `state-reducer.ts` `nav` / `focus_options` /
 *   `focus_chat` cases.
 * - `blocksMultiToggle` — in multiSelect mode, Space (and Enter-as-toggle)
 *   on this row is suppressed. The Next sentinel is the only true.
 * - `autoSubmitsInMulti` — in multiSelect mode, Enter on this row commits
 *   the question (emits `multi_confirm`). The Next sentinel is the only true.
 * - `autoAppendOnSingleSelectNoPreview` — `buildItemsForQuestion` appends
 *   this row when the question is single-select AND no option carries a
 *   `preview`. The "other" sentinel is the only true.
 * - `autoAppendOnMultiSelect` — `buildItemsForQuestion` appends this row
 *   when the question is multi-select. The Next sentinel is the only true.
 */
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
		numbered: false,
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
