import type { Theme } from "@bastani/atomic";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { ResolvedStepBehavior } from "../../shared/settings.ts";
import { updateBehavior } from "./chain-clarify-behavior.ts";
import { enterEditMode, handleEditInput } from "./chain-clarify-edit.ts";
import { renderChainMode, renderParallelMode, renderSingleMode } from "./chain-clarify-render-modes.ts";
import { renderFullEditMode, renderModelSelector, renderSkillSelector, renderThinkingSelector } from "./chain-clarify-render-selectors.ts";
import { enterModelSelector, enterSkillSelector, enterThinkingSelector, handleModelSelectorInput, handleSkillSelectorInput, handleThinkingSelectorInput } from "./chain-clarify-selectors.ts";
import { CHAIN_CLARIFY_WIDTH, createChainClarifyState, disposeNoticeTimer, type ChainClarifyState } from "./chain-clarify-state.ts";
import type { BehaviorOverride, ChainClarifyResult, ClarifyMode, SkillOption } from "./chain-clarify-types.ts";

/**
 * TUI component for chain clarification.
 * Factory signature matches ctx.ui.custom: (tui, theme, kb, done) => Component
 */
export class ChainClarifyComponent implements Component {
	readonly width = CHAIN_CLARIFY_WIDTH;
	private readonly state: ChainClarifyState;

	constructor(
		tui: TUI,
		theme: Theme,
		agentConfigs: AgentConfig[],
		templates: string[],
		originalTask: string,
		chainDir: string | undefined,
		resolvedBehaviors: ResolvedStepBehavior[],
		availableModels: ModelInfo[],
		preferredProvider: string | undefined,
		availableSkills: SkillOption[],
		done: (result: ChainClarifyResult) => void,
		mode: ClarifyMode = "chain",
	) {
		this.state = createChainClarifyState({
			tui,
			theme,
			agentConfigs,
			templates,
			originalTask,
			chainDir,
			resolvedBehaviors,
			availableModels,
			preferredProvider,
			availableSkills,
			done,
			mode,
		});
	}

	handleInput(data: string): void {
		const state = this.state;
		if (state.editingStep !== null) {
			this.handleModalInput(data);
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			state.done({ confirmed: false, templates: [], behaviorOverrides: [] });
			return;
		}

		if (matchesKey(data, "return")) {
			const overrides: (BehaviorOverride | undefined)[] = [];
			for (let i = 0; i < state.agentConfigs.length; i++) {
				overrides.push(state.behaviorOverrides.get(i));
			}
			state.done({
				confirmed: true,
				templates: state.templates,
				behaviorOverrides: overrides,
				runInBackground: state.runInBackground,
			});
			return;
		}

		if (matchesKey(data, "up")) {
			state.selectedStep = Math.max(0, state.selectedStep - 1);
			state.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			const maxStep = Math.max(0, state.agentConfigs.length - 1);
			state.selectedStep = Math.min(maxStep, state.selectedStep + 1);
			state.tui.requestRender();
			return;
		}

		this.handleMainShortcut(data);
	}

	private handleModalInput(data: string): void {
		const state = this.state;
		if (state.editMode === "model") {
			handleModelSelectorInput(state, data);
		} else if (state.editMode === "thinking") {
			handleThinkingSelectorInput(state, data);
		} else if (state.editMode === "skills") {
			handleSkillSelectorInput(state, data);
		} else {
			handleEditInput(state, data);
		}
	}

	private handleMainShortcut(data: string): void {
		const state = this.state;
		if (data === "e") {
			enterEditMode(state, "template");
			return;
		}

		if (data === "m") {
			enterModelSelector(state);
			return;
		}

		if (data === "t") {
			enterThinkingSelector(state);
			return;
		}

		if (data === "s") {
			enterSkillSelector(state);
			return;
		}

		if (data === "w" && state.mode !== "parallel") {
			enterEditMode(state, "output");
			return;
		}

		if (data === "r" && state.mode === "chain") {
			enterEditMode(state, "reads");
			return;
		}

		if (data === "p" && state.mode === "chain") {
			this.toggleProgressForAllSteps();
			return;
		}

		if (data === "b") {
			state.runInBackground = !state.runInBackground;
			state.tui.requestRender();
		}
	}

	private toggleProgressForAllSteps(): void {
		const state = this.state;
		const anyEnabled = state.agentConfigs.some((_, i) => {
			const override = state.behaviorOverrides.get(i);
			const base = state.resolvedBehaviors[i]!;
			return override?.progress !== undefined ? override.progress : base.progress;
		});
		const newState = !anyEnabled;
		for (let i = 0; i < state.agentConfigs.length; i++) {
			updateBehavior(state, i, "progress", newState);
		}
		state.tui.requestRender();
	}

	render(_width: number): string[] {
		const state = this.state;
		if (state.editingStep !== null) {
			return this.renderModal();
		}

		switch (state.mode) {
			case "single":
				return renderSingleMode(state);
			case "parallel":
				return renderParallelMode(state);
			case "chain":
				return renderChainMode(state);
		}
	}

	private renderModal(): string[] {
		const state = this.state;
		switch (state.editMode) {
			case "model":
				return renderModelSelector(state);
			case "thinking":
				return renderThinkingSelector(state);
			case "skills":
				return renderSkillSelector(state);
			case "template":
			case "output":
			case "reads":
				return renderFullEditMode(state);
		}
	}

	invalidate(): void {}

	dispose(): void {
		disposeNoticeTimer(this.state);
	}
}
