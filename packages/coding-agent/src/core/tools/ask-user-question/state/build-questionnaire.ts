import { Input } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "../../../../modes/interactive/theme/theme.ts";
import type { QuestionData } from "../tool/types.ts";
import {
	type BoundGlobalBinding,
	type BoundPerTabBinding,
	globalBinding,
	perTabBinding,
} from "../view/component-binding.ts";
import { ChatRowView } from "../view/components/chat-row-view.ts";
import { MultiSelectView } from "../view/components/multi-select-view.ts";
import { OptionListView } from "../view/components/option-list-view.ts";
import { PreviewBlockRenderer } from "../view/components/preview/preview-block-renderer.ts";
import { crossTabLeftWidthWithDonation } from "../view/components/preview/preview-layout-decider.ts";
import type { PreviewPaneProps } from "../view/components/preview/preview-pane.ts";
import { PreviewPane } from "../view/components/preview/preview-pane.ts";
import { SubmitPicker } from "../view/components/submit-picker.ts";
import { TabBar } from "../view/components/tab-bar.ts";
import type { WrappingSelectItem, WrappingSelectTheme } from "../view/components/wrapping-select.ts";
import { DialogView } from "../view/dialog-builder.ts";
import { QuestionnairePropsAdapter } from "../view/props-adapter.ts";
import type { StatefulView } from "../view/stateful-view.ts";
import type { TabBodyHeights, TabComponents } from "../view/tab-components.ts";
import { ROW_INTENT_META } from "./row-intent.ts";
import type { PerTabSelector } from "./selectors/contract.ts";
import { selectActivePreviewPaneIndex } from "./selectors/derivations.ts";
import {
	selectChatRowProps,
	selectDialogProps,
	selectMultiSelectProps,
	selectOptionListProps,
	selectPreviewPaneProps,
	selectSubmitPickerProps,
	selectTabBarProps,
} from "./selectors/projections.ts";
import type { QuestionnaireState } from "./state.ts";

export interface QuestionnaireBuildConfig {
	tui: { terminal: { columns: number }; requestRender(): void };
	theme: Theme;
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	isMulti: boolean;
	initialState: QuestionnaireState;
	getCurrentTab: () => number;
}

export interface QuestionnaireBuilt {
	adapter: QuestionnairePropsAdapter;
	notesInput: Input;
	inlineInput: Input;
	render: (width: number) => string[];
	invalidate: () => void;
}

interface HeightComputers {
	global: (width: number) => number;
	current: (width: number) => number;
}

function previewBodyHeights(pane: PreviewPane): (width: number) => TabBodyHeights {
	return (width) => ({
		current: pane.naturalHeight(width),
		max: pane.maxNaturalHeight(width),
	});
}

function multiSelectBodyHeights(view: MultiSelectView): (width: number) => TabBodyHeights {
	return (width) => {
		const h = view.naturalHeight(width);
		return { current: h, max: h };
	};
}

const isActiveTab: PerTabSelector<boolean> = (s, ctx) =>
	ctx.i === selectActivePreviewPaneIndex(s.currentTab, ctx.totalQuestions);

/**
 * Pure factory: assembles every TUI component, the props adapter, and a
 * lifecycle handle. Session-state dependencies arrive via `getCurrentTab` and
 * the `inputBuffer` cell. Initial paint is delegated to
 * `adapter.apply(initialState)` (called by the session at construction-end);
 * no selector is invoked here.
 */
export function buildQuestionnaire(config: QuestionnaireBuildConfig): QuestionnaireBuilt {
	return new QuestionnaireBuilder(config).build();
}

/**
 * Programming-by-intention assembly: each private method names one
 * construction step from `build()`. Read top-down; the class is build-only and
 * discarded once the handle is returned.
 */
class QuestionnaireBuilder {
	private readonly tui: QuestionnaireBuildConfig["tui"];
	private readonly theme: Theme;
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly isMulti: boolean;
	private readonly initialState: QuestionnaireState;
	private readonly getCurrentTab: () => number;

	private readonly selectTheme: WrappingSelectTheme;
	private readonly markdownTheme = getMarkdownTheme();
	private readonly chatRow: ChatRowView;
	private readonly notesInput = new Input();
	private readonly inlineInput = new Input();
	private readonly getTerminalWidth = () => this.tui.terminal.columns;

	constructor(config: QuestionnaireBuildConfig) {
		this.tui = config.tui;
		this.theme = config.theme;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.isMulti = config.isMulti;
		this.initialState = config.initialState;
		this.getCurrentTab = config.getCurrentTab;

		this.selectTheme = this.makeSelectTheme();
		this.chatRow = new ChatRowView({
			item: { kind: "chat", label: ROW_INTENT_META.chat.label },
			theme: this.selectTheme,
		});
	}

	build(): QuestionnaireBuilt {
		const tabs = this.buildTabComponents();
		this.injectGlobalLeftWidth(tabs);
		const submitPicker = this.buildSubmitPicker();
		const tabBar = this.buildTabBar();
		const heights = this.buildHeightComputers(tabs);
		const dialog = this.buildDialog(tabs, submitPicker, tabBar, heights);
		const globalBindings = this.buildGlobalBindings(dialog, submitPicker, tabBar);
		const perTabBindings = this.buildPerTabBindings();
		const adapter = this.buildAdapter(tabs, globalBindings, perTabBindings);
		return this.handle(adapter, dialog);
	}

	private makeSelectTheme(): WrappingSelectTheme {
		const t = this.theme;
		return {
			selectedText: (s) => t.fg("accent", t.bold(s)),
			description: (s) => t.fg("muted", s),
			scrollInfo: (s) => t.fg("dim", s),
		};
	}

	private buildTabComponents(): ReadonlyArray<TabComponents> {
		return this.questions.map((q, i) => this.buildTabFor(q, i));
	}

	private buildTabFor(question: QuestionData, index: number): TabComponents {
		const optionList = new OptionListView({
			items: this.itemsByTab[index] ?? [],
			theme: this.selectTheme,
		});
		const previewBlock = new PreviewBlockRenderer({
			question,
			theme: this.theme,
			markdownTheme: this.markdownTheme,
		});
		const preview = new PreviewPane({
			question,
			getTerminalWidth: this.getTerminalWidth,
			optionListView: optionList,
			previewBlock,
		});
		const multiSelect = question.multiSelect ? new MultiSelectView(this.theme, question) : undefined;
		const bodyHeights = this.buildBodyHeights(question, preview, multiSelect);
		return { optionList, preview, multiSelect, bodyHeights };
	}

	private buildBodyHeights(
		question: QuestionData,
		preview: PreviewPane,
		multiSelect: MultiSelectView | undefined,
	): (width: number) => TabBodyHeights {
		return question.multiSelect ? multiSelectBodyHeights(multiSelect!) : previewBodyHeights(preview);
	}

	/**
	 * Compute cross-tab max adaptive left width and inject into each PreviewPane.
	 * Mirrors buildHeightComputers pattern — iterates all tabs, takes max.
	 * Called after buildTabComponents, before buildDialog (so setGlobalLeftWidth
	 * is set before any rendering occurs).
	 */
	private injectGlobalLeftWidth(tabs: ReadonlyArray<TabComponents>): void {
		const questions = this.questions;
		const itemsByTab = this.itemsByTab;
		const tabsDescriptor = questions.map((q) => ({ multiSelect: q.multiSelect }));
		const globalLeftWidth = (paneWidth: number): number =>
			crossTabLeftWidthWithDonation(tabsDescriptor, itemsByTab, questions, paneWidth);
		for (const tab of tabs) {
			tab.preview.setGlobalLeftWidth(globalLeftWidth);
		}
	}

	private buildSubmitPicker(): SubmitPicker | undefined {
		return this.isMulti ? new SubmitPicker(this.theme) : undefined;
	}

	private buildTabBar(): TabBar | undefined {
		return this.isMulti ? new TabBar(this.theme) : undefined;
	}

	private buildHeightComputers(tabs: ReadonlyArray<TabComponents>): HeightComputers {
		const global = (width: number): number => {
			let max = 0;
			for (const tab of tabs) {
				const h = tab.bodyHeights(width).max;
				if (h > max) max = h;
			}
			return Math.max(1, max);
		};
		const current = (width: number): number => {
			const idx = Math.min(this.getCurrentTab(), tabs.length - 1);
			return Math.max(0, tabs[idx]?.bodyHeights(width).current ?? 0);
		};
		return { global, current };
	}

	private pickInitialActivePreview(tabs: ReadonlyArray<TabComponents>): StatefulView<PreviewPaneProps> {
		const idx = selectActivePreviewPaneIndex(this.initialState.currentTab, this.questions.length);
		return tabs[idx]?.preview ?? tabs[0]!.preview;
	}

	private buildDialog(
		tabs: ReadonlyArray<TabComponents>,
		submitPicker: SubmitPicker | undefined,
		tabBar: TabBar | undefined,
		heights: HeightComputers,
	): DialogView {
		return new DialogView(
			{
				theme: this.theme,
				questions: this.questions,
				tabBar,
				notesInput: this.notesInput,
				chatRow: this.chatRow,
				isMulti: this.isMulti,
				tabsByIndex: tabs,
				submitPicker,
				getBodyHeight: heights.global,
				getCurrentBodyHeight: heights.current,
			},
			{ state: this.initialState, activePreviewPane: this.pickInitialActivePreview(tabs) },
		);
	}

	private buildGlobalBindings(
		dialog: DialogView,
		submitPicker: SubmitPicker | undefined,
		tabBar: TabBar | undefined,
	): ReadonlyArray<BoundGlobalBinding> {
		return [
			globalBinding({ component: dialog, select: selectDialogProps }),
			globalBinding({ component: this.chatRow, select: selectChatRowProps }),
			...(submitPicker ? [globalBinding({ component: submitPicker, select: selectSubmitPickerProps })] : []),
			...(tabBar ? [globalBinding({ component: tabBar, select: selectTabBarProps })] : []),
		];
	}

	private buildPerTabBindings(): ReadonlyArray<BoundPerTabBinding> {
		return [
			perTabBinding({
				resolve: (tab) => tab.optionList,
				predicate: isActiveTab,
				select: selectOptionListProps,
			}),
			perTabBinding({
				resolve: (tab) => tab.preview,
				predicate: isActiveTab,
				select: selectPreviewPaneProps,
			}),
			perTabBinding({
				resolve: (tab) => tab.multiSelect,
				select: selectMultiSelectProps,
			}),
		];
	}

	private buildAdapter(
		tabs: ReadonlyArray<TabComponents>,
		globalBindings: ReadonlyArray<BoundGlobalBinding>,
		perTabBindings: ReadonlyArray<BoundPerTabBinding>,
	): QuestionnairePropsAdapter {
		return new QuestionnairePropsAdapter({
			tui: this.tui,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			tabsByIndex: tabs,
			inlineInput: this.inlineInput,
			globalBindings,
			perTabBindings,
			extraInvalidatables: [this.notesInput],
		});
	}

	private handle(adapter: QuestionnairePropsAdapter, dialog: DialogView): QuestionnaireBuilt {
		return {
			adapter,
			notesInput: this.notesInput,
			inlineInput: this.inlineInput,
			render: (w) => dialog.render(w),
			invalidate: () => adapter.invalidate(),
		};
	}
}
