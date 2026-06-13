import type { Input } from "@earendil-works/pi-tui";
import type { BindingContext, PerTabBindingContext } from "../state/selectors/contract.ts";
import { selectActivePreviewPaneIndex } from "../state/selectors/derivations.ts";
import { selectActiveView } from "../state/selectors/focus.ts";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.ts";
import type { BoundGlobalBinding, BoundPerTabBinding } from "./component-binding.ts";
import type { WrappingSelectItem } from "./components/wrapping-select.ts";
import type { TabComponents } from "./tab-components.ts";

/** Cache-invalidation contract used by the adapter. `pi-tui` `Component` already satisfies it. */
interface Invalidatable {
	invalidate(): void;
}

export interface QuestionnairePropsAdapterConfig {
	tui: { requestRender(): void };
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	inlineInput: Input;
	globalBindings: ReadonlyArray<BoundGlobalBinding>;
	perTabBindings: ReadonlyArray<BoundPerTabBinding>;
	/**
	 * Renderables not reached by the binding registries (e.g. the notes
	 * `Input`, which is typed into directly and has no props). Walked by
	 * `invalidate()` after the binding-driven components.
	 */
	extraInvalidatables?: ReadonlyArray<Invalidatable>;
}

/**
 * View fan-out: drives every component setter from the canonical state via
 * two binding registries. `globalBindings` covers the cross-tab components
 * (chatRow, dialog, submitPicker?, tabBar?); `perTabBindings` covers the
 * per-tab kinds (optionList, preview, multiSelect?). The hand-coded fan-out
 * collapses to one global loop + one nested per-tab loop. The shared inline
 * input is projected through owner-specific draft slots so the option list and
 * chat footer never display each other's in-flight text.
 */
export class QuestionnairePropsAdapter {
	private readonly tui: QuestionnairePropsAdapterConfig["tui"];
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly tabsByIndex: ReadonlyArray<TabComponents>;
	private readonly inlineInput: Input;
	private readonly globalBindings: ReadonlyArray<BoundGlobalBinding>;
	private readonly perTabBindings: ReadonlyArray<BoundPerTabBinding>;
	private readonly extraInvalidatables: ReadonlyArray<Invalidatable>;

	constructor(config: QuestionnairePropsAdapterConfig) {
		this.tui = config.tui;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.tabsByIndex = config.tabsByIndex;
		this.inlineInput = config.inlineInput;
		this.globalBindings = config.globalBindings;
		this.perTabBindings = config.perTabBindings;
		this.extraInvalidatables = config.extraInvalidatables ?? [];
	}

	apply(state: QuestionnaireState): void {
		const totalQuestions = this.questions.length;
		const activeView = selectActiveView(state, totalQuestions);
		const paneIndex = selectActivePreviewPaneIndex(state.currentTab, totalQuestions);
		const activePreviewPane = this.tabsByIndex[paneIndex]?.preview ?? this.tabsByIndex[0]!.preview;

		const liveInlineValue = this.inlineInput.getValue();
		const inputBuffer =
			state.customDraftByTab.get(state.currentTab) ??
			(state.inlineInputOwner === "other" ? liveInlineValue : "");
		const inputCaret = state.customCaretByTab.get(state.currentTab) ?? inputBuffer.length;
		const chatInputBuffer =
			state.chatDraftByTab.get(state.currentTab) ??
			(state.inlineInputOwner === "chat" ? liveInlineValue : "");
		const chatInputCaret = state.chatCaretByTab.get(state.currentTab) ?? chatInputBuffer.length;
		const ctx: BindingContext = {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			totalQuestions,
			activeView,
			inputBuffer,
			inputCaret,
			chatInputBuffer,
			chatInputCaret,
			activePreviewPane,
		};

		for (const binding of this.globalBindings) {
			binding.apply(state, ctx);
		}

		for (let i = 0; i < this.tabsByIndex.length; i++) {
			const tab = this.tabsByIndex[i]!;
			const tabCtx: PerTabBindingContext = { ...ctx, tab, i };
			for (const binding of this.perTabBindings) {
				binding.apply(state, tabCtx);
			}
		}

		this.tui.requestRender();
	}

	/**
	 * Invalidates every owned renderable. Called by the session in place of
	 * the old `dialog.invalidate()` forwarding chain — DialogView no longer
	 * reaches into siblings (chatRow, tabBar, notesInput, activePreviewPane).
	 * Iterates the same registries used by `apply()` plus
	 * `extraInvalidatables` for components outside the binding system.
	 */
	invalidate(): void {
		for (const b of this.globalBindings) b.invalidate();
		for (const tab of this.tabsByIndex) {
			tab.optionList.invalidate();
			tab.preview.invalidate();
			tab.multiSelect?.invalidate();
		}
		for (const x of this.extraInvalidatables) x.invalidate();
	}
}
