import type { Theme } from "@bastani/atomic";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { ResolvedStepBehavior } from "../../shared/settings.ts";
import { createEditorState, type TextEditorState } from "./chain-clarify-editor.ts";
import type { BehaviorOverride, ChainClarifyResult, ClarifyMode, EditMode, NoticeMessage, SkillOption } from "./chain-clarify-types.ts";

export const CHAIN_CLARIFY_WIDTH = 84;
export const EDIT_VIEWPORT_HEIGHT = 12;
export const MODEL_SELECTOR_HEIGHT = 10;

export interface ChainClarifyState {
	selectedStep: number;
	editingStep: number | null;
	editMode: EditMode;
	editState: TextEditorState;
	behaviorOverrides: Map<number, BehaviorOverride>;
	modelSearchQuery: string;
	modelSelectedIndex: number;
	filteredModels: ModelInfo[];
	thinkingSelectedIndex: number;
	skillSearchQuery: string;
	skillSelectedNames: Set<string>;
	skillCursorIndex: number;
	filteredSkills: SkillOption[];
	noticeMessage: NoticeMessage | null;
	noticeMessageTimer: ReturnType<typeof setTimeout> | null;
	runInBackground: boolean;
	tui: TUI;
	theme: Theme;
	agentConfigs: AgentConfig[];
	templates: string[];
	originalTask: string;
	chainDir: string | undefined;
	resolvedBehaviors: ResolvedStepBehavior[];
	availableModels: ModelInfo[];
	preferredProvider: string | undefined;
	availableSkills: SkillOption[];
	done: (result: ChainClarifyResult) => void;
	mode: ClarifyMode;
	width: number;
}

export interface ChainClarifyStateParams {
	tui: TUI;
	theme: Theme;
	agentConfigs: AgentConfig[];
	templates: string[];
	originalTask: string;
	chainDir: string | undefined;
	resolvedBehaviors: ResolvedStepBehavior[];
	availableModels: ModelInfo[];
	preferredProvider: string | undefined;
	availableSkills: SkillOption[];
	done: (result: ChainClarifyResult) => void;
	mode: ClarifyMode;
}

export function createChainClarifyState(params: ChainClarifyStateParams): ChainClarifyState {
	return {
		selectedStep: 0,
		editingStep: null,
		editMode: "template",
		editState: createEditorState(),
		behaviorOverrides: new Map(),
		modelSearchQuery: "",
		modelSelectedIndex: 0,
		filteredModels: [...params.availableModels],
		thinkingSelectedIndex: 0,
		skillSearchQuery: "",
		skillSelectedNames: new Set(),
		skillCursorIndex: 0,
		filteredSkills: [...params.availableSkills],
		noticeMessage: null,
		noticeMessageTimer: null,
		runInBackground: false,
		tui: params.tui,
		theme: params.theme,
		agentConfigs: params.agentConfigs,
		templates: params.templates,
		originalTask: params.originalTask,
		chainDir: params.chainDir,
		resolvedBehaviors: params.resolvedBehaviors,
		availableModels: params.availableModels,
		preferredProvider: params.preferredProvider,
		availableSkills: params.availableSkills,
		done: params.done,
		mode: params.mode,
		width: CHAIN_CLARIFY_WIDTH,
	};
}

export function exitEditMode(state: ChainClarifyState): void {
	state.editingStep = null;
	state.editState = createEditorState();
	state.tui.requestRender();
}

export function disposeNoticeTimer(state: ChainClarifyState): void {
	if (state.noticeMessageTimer) clearTimeout(state.noticeMessageTimer);
	state.noticeMessageTimer = null;
}
