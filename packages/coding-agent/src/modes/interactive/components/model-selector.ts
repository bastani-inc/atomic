import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { type Api, getSupportedThinkingLevels, type Model, modelsAreEqual } from "@bastani/atomic-ai/compat";
import { type Focusable, getKeybindings, type TUI } from "@bastani/atomic-tui";
import { boundedInteractiveModelRefresh } from "../../../core/bounded-model-refresh.ts";
import { formatModelLabel } from "../../../core/model-label.ts";
import type { ModelRuntime } from "../../../core/model-runtime.js";
import {
	type ModelSwitchThinkingContext,
	thinkingLevelForModelSwitch,
} from "../../../core/model-switch-thinking-level.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getDistinctModelName, getModelSelectorSearchText } from "../model-search.ts";
import { navActionText } from "./nav-keys.ts";
import { FramedSelector, type SelectorItem } from "./selector.ts";

interface ScopedModelItem {
	model: Model<Api>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "scoped";

const MAX_VISIBLE = 10;
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * The `/model` picker. Each row is the model's raw ID and the level selecting it applies, exactly what
 * `--model provider/id:level` takes (#4269); a display name that adds words the ID lacks follows in a dim column. The
 * current model is marked `●`, the saved default is tagged. ←→ change the level a reasoning model is selected at, and
 * tab switches between all models and the scoped ones when a scope is set.
 */
export class ModelSelectorComponent extends FramedSelector<Model<Api>> implements Focusable {
	private allModels: Model<Api>[] = [];
	private scopedModelList: Model<Api>[] = [];
	private readonly currentModel?: Model<Api>;
	private readonly thinkingContext: ModelSwitchThinkingContext;
	private readonly defaultModelKey?: string;
	private readonly modelRuntime: ModelRuntime;
	private readonly tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope;
	/** Levels the user picked with ←→ for a row; rows without one use the level selecting them applies. */
	private readonly chosenLevels = new Map<string, ThinkingLevel>();
	private readonly refreshAbortController = new AbortController();
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<Api> | undefined,
		settingsManager: SettingsManager,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<Api>, thinkingLevel?: ThinkingLevel) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		/**
		 * The level the current model runs at. Rows show the level selecting each model applies, which a model without a
		 * saved level inherits from this one while the current model reasons.
		 */
		currentThinkingLevel?: ThinkingLevel,
	) {
		const holder: { self?: ModelSelectorComponent } = {};
		const scope: ModelScope = scopedModels.length > 0 ? "scoped" : "all";
		super({
			title: "Select model",
			subtitle:
				scopedModels.length > 0
					? undefined
					: "Only showing models from configured providers. Use /login to add providers.",
			search: true,
			initialQuery: initialSearchInput,
			items: [],
			maxVisible: MAX_VISIBLE,
			emptyText: "No models available. Use /login to add a provider.",
			onSelect: (item) => {
				const self = holder.self;
				if (!self) return;
				const chosen = self.chosenLevels.get(item.id);
				self.dispose();
				if (chosen === undefined) onSelect(item.value);
				else onSelect(item.value, chosen);
			},
			onCancel: () => {
				holder.self?.dispose();
				onCancel();
			},
			extraKeys: [
				{
					hint: { keys: "←→", label: "effort" },
					matches: (data) => data === LEFT || data === RIGHT,
					enabled: (item) => item !== undefined && holder.self?.levelsFor(item.value).length !== 0,
					run: () => {},
				},
				{
					hint: { keys: navActionText(getKeybindings(), "tui.input.tab") || "tab", label: "all/scoped" },
					matches: (data) => getKeybindings().matches(data, "tui.input.tab"),
					enabled: () => (holder.self?.scopedModelList.length ?? 0) > 0,
					run: () => holder.self?.toggleScope(),
				},
			],
		});
		holder.self = this;
		this.tui = tui;
		this.currentModel = currentModel;
		this.thinkingContext = {
			settings: settingsManager,
			...(currentThinkingLevel === undefined
				? {}
				: { current: { model: currentModel, thinkingLevel: currentThinkingLevel } }),
		};
		const defaultProvider = settingsManager.getDefaultProvider();
		const defaultModel = settingsManager.getDefaultModel();
		this.defaultModelKey = defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : undefined;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.scope = scope;
		this.selector.setNotice({ text: "Refreshing model catalogs…", tone: "muted" });
		this.loadModelsFromSnapshot();
		this.rebuild(currentModel ? modelKey(currentModel) : undefined);
		this.tui.requestRender();
		void this.refreshModels();
	}

	override handleInput(data: string): void {
		// ←→ step the level of the selected reasoning model; the selector's extra key only reserves them.
		if (data === LEFT || data === RIGHT) {
			const item = this.selector.getSelected();
			if (item) this.stepLevel(item.value, data === RIGHT ? 1 : -1);
			return;
		}
		super.handleInput(data);
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.refreshAbortController.abort();
	}

	/** Levels ←→ step through for `model`: none for a model that does not reason. */
	levelsFor(model: Model<Api>): ThinkingLevel[] {
		if (!model.reasoning) return [];
		return getSupportedThinkingLevels(model) as ThinkingLevel[];
	}

	private levelOf(model: Model<Api>): ThinkingLevel | undefined {
		return this.chosenLevels.get(modelKey(model)) ?? thinkingLevelForModelSwitch(model, this.thinkingContext);
	}

	private stepLevel(model: Model<Api>, direction: 1 | -1): void {
		const levels = this.levelsFor(model);
		if (levels.length === 0) return;
		const current = this.levelOf(model);
		const index = current === undefined ? -1 : levels.indexOf(current);
		const next = levels[Math.max(0, Math.min(levels.length - 1, (index < 0 ? 0 : index) + direction))];
		if (next === undefined || next === current) return;
		this.chosenLevels.set(modelKey(model), next);
		this.rebuild();
	}

	private loadModelsFromSnapshot(): void {
		this.allModels = this.sortModels([...this.modelRuntime.getAvailableSnapshot()]);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelList = this.scopedModels.map((scoped) => scoped.model);
	}

	/** Current model first, the saved default second, then by provider. */
	private sortModels(models: Model<Api>[]): Model<Api>[] {
		return models.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a);
			const bIsCurrent = modelsAreEqual(this.currentModel, b);
			if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
			const aIsDefault = modelKey(a) === this.defaultModelKey;
			const bIsDefault = modelKey(b) === this.defaultModelKey;
			if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;
			return a.provider.localeCompare(b.provider);
		});
	}

	private toggleScope(): void {
		if (this.scopedModelList.length === 0) return;
		this.scope = this.scope === "all" ? "scoped" : "all";
		this.selector.setQuery(this.selector.state.getQuery());
		this.rebuild(this.currentModel ? modelKey(this.currentModel) : undefined);
	}

	private rebuild(preferId?: string): void {
		const models = this.scope === "scoped" ? this.scopedModelList : this.allModels;
		const items = models.map((model): SelectorItem<Model<Api>> => {
			const key = modelKey(model);
			const isCurrent = modelsAreEqual(this.currentModel, model);
			const isDefault = key === this.defaultModelKey;
			const name = getDistinctModelName({ id: model.id, name: model.name });
			return {
				id: key,
				value: model,
				label: formatModelLabel(model, { thinkingLevel: this.levelOf(model) }),
				description: name,
				mark: isCurrent ? "on" : "off",
				tag: isCurrent ? "current" : isDefault ? "default" : undefined,
				tagTone: isCurrent ? "success" : "muted",
				searchText: `${getModelSelectorSearchText({ id: model.id, provider: model.provider, name: model.name })} ${isDefault ? "default" : ""}`,
			};
		});
		this.selector.setItems(items, preferId);
		if (this.scopedModelList.length > 0) {
			this.selector.setSubtitle(`Scope: ${this.scope === "scoped" ? "scoped models" : "all models"}`);
		}
	}

	private async refreshModels(): Promise<void> {
		const outcome = await boundedInteractiveModelRefresh(
			(options) => refreshModelCatalogs(this.modelRuntime, options),
			{},
			this.refreshAbortController.signal,
		);
		if (this.closed) return;
		let notice: { text: string; tone: "error" | "success" } | undefined;
		if (outcome.status === "timed-out") {
			notice = { text: "Model refresh timed out; showing cached models.", tone: "error" };
		} else if (outcome.status === "rejected") {
			notice = { text: "Could not refresh model catalogs; showing cached models.", tone: "error" };
		} else if (outcome.status === "success" && outcome.value.errors.size === 1) {
			notice = {
				text: `Could not refresh ${outcome.value.errors.keys().next().value}; showing cached models.`,
				tone: "error",
			};
		} else if (outcome.status === "success" && outcome.value.errors.size > 1) {
			notice = {
				text: `Could not refresh ${outcome.value.errors.size} model catalogs; showing cached models.`,
				tone: "error",
			};
		} else if (outcome.status === "success") {
			const error = this.modelRuntime.getError();
			notice = error ? { text: error, tone: "error" } : { text: "Model catalogs refreshed.", tone: "success" };
		}
		this.selector.setNotice(notice);
		// The browsed row stays selected when it is still listed; otherwise the current model, else the same position.
		this.loadModelsFromSnapshot();
		this.rebuild(this.currentModel ? modelKey(this.currentModel) : undefined);
		this.tui.requestRender();
	}
}
