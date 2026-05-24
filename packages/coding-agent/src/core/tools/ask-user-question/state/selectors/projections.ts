import type { ChatRowViewProps } from "../../view/components/chat-row-view.ts";
import { MULTI_SUBMIT_LABEL, type MultiSelectViewProps } from "../../view/components/multi-select-view.ts";
import type { OptionListViewProps } from "../../view/components/option-list-view.ts";
import type { PreviewPaneProps } from "../../view/components/preview/preview-pane.ts";
import type { SubmitPickerProps } from "../../view/components/submit-picker.ts";
import type { TabBarProps } from "../../view/components/tab-bar.ts";
import type { DialogProps } from "../../view/dialog-builder.ts";
import { ROW_INTENT_META } from "../row-intent.ts";
import type { GlobalSelector, PerTabSelector } from "./contract.ts";
import { chatNumberingFor, selectActiveTabItems, selectConfirmedIndicator } from "./derivations.ts";

export const selectMultiSelectProps: PerTabSelector<MultiSelectViewProps> = (state, ctx) => {
	const question = ctx.questions[ctx.i];
	if (!question) return { rows: [], nextActive: false, nextLabel: ROW_INTENT_META.next.label };
	const focused = ctx.activeView === "options";
	const rows: { checked: boolean; active: boolean }[] = [];
	for (let i = 0; i < question.options.length; i++) {
		rows.push({
			checked: state.multiSelectChecked.has(i),
			active: focused && i === state.optionIndex,
		});
	}
	const nextActive = focused && state.optionIndex === question.options.length;
	const isLastQuestion = ctx.i === ctx.questions.length - 1;
	const nextLabel = isLastQuestion ? MULTI_SUBMIT_LABEL : ROW_INTENT_META.next.label;
	return { rows, nextActive, nextLabel };
};

export const selectOptionListProps: PerTabSelector<OptionListViewProps> = (state, ctx) => {
	const items = ctx.itemsByTab[ctx.i] ?? [];
	const focused = ctx.activeView === "options";
	const confirmed = selectConfirmedIndicator(ctx.questions, state.currentTab, state.answers, items);
	return {
		selectedIndex: state.optionIndex,
		focused,
		inputBuffer: ctx.inputBuffer,
		inputCaret: ctx.inputCaret,
		...(confirmed ? { confirmed } : {}),
	};
};

export const selectSubmitPickerProps: GlobalSelector<SubmitPickerProps> = (state, ctx) => {
	const focused = ctx.activeView === "submit";
	return {
		rows: [
			{ active: focused && state.submitChoiceIndex === 0 },
			{ active: focused && state.submitChoiceIndex === 1 },
		],
	};
};

export const selectPreviewPaneProps: PerTabSelector<PreviewPaneProps> = (state, ctx) => ({
	notesVisible: state.notesVisible,
	selectedIndex: state.optionIndex,
	focused: ctx.activeView === "options",
});

export const selectTabBarProps: GlobalSelector<TabBarProps> = (state, ctx) => {
	const tabs = ctx.questions.map((q, i) => ({
		label: q.header && q.header.length > 0 ? q.header : `Q${i + 1}`,
		answered: state.answers.has(i),
		active: i === state.currentTab,
	}));
	return {
		tabs,
		submit: {
			active: state.currentTab === ctx.questions.length,
			allAnswered: state.answers.size === ctx.questions.length && ctx.questions.length > 0,
		},
	};
};

export const selectChatRowProps: GlobalSelector<ChatRowViewProps> = (state, ctx) => {
	const activeItems = selectActiveTabItems(ctx.itemsByTab, state.currentTab, ctx.totalQuestions);
	return {
		focused: ctx.activeView === "chat",
		numbering: chatNumberingFor(activeItems),
	};
};

export const selectDialogProps: GlobalSelector<DialogProps> = (state, ctx) => ({
	state,
	activePreviewPane: ctx.activePreviewPane,
});
