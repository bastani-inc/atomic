import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	modelsAreEqual,
} from "@bastani/atomic-ai/compat";
import {
	type Focusable,
	getKeybindings,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@bastani/atomic-tui";
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

function effortDirection(data: string): -1 | 1 | 0 {
	if (matchesKey(data, "left")) return -1;
	if (matchesKey(data, "right")) return 1;
	return 0;
}

interface StaticModelTextMeta {
	descriptionResolved: boolean;
	descriptionValue: string | undefined;
	searchTextValue: string | undefined;
}

interface CachedModelMeta {
	readonly id: string;
	readonly provider: string;
	readonly name: string | undefined;
	readonly reasoning: boolean;
	readonly key: string;
	readonly labels: Map<ThinkingLevel | undefined, string>;
	readonly textMeta: StaticModelTextMeta;
}

const modelMetaCache = new WeakMap<Model<Api>, CachedModelMeta>();
const compareProviders = new Intl.Collator().compare;

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function getModelMeta(model: Model<Api>): CachedModelMeta {
	const existing = modelMetaCache.get(model);
	if (
		existing &&
		existing.id === model.id &&
		existing.provider === model.provider &&
		existing.name === model.name &&
		existing.reasoning === Boolean(model.reasoning)
	) {
		return existing;
	}
	const key = modelKey(model);
	const created: CachedModelMeta = {
		id: model.id,
		provider: model.provider,
		name: model.name,
		reasoning: Boolean(model.reasoning),
		key,
		labels: new Map(),
		textMeta: { descriptionResolved: false, descriptionValue: undefined, searchTextValue: undefined },
	};
	modelMetaCache.set(model, created);
	return created;
}

function getCachedDescription(model: Model<Api>, meta: CachedModelMeta): string | undefined {
	if (!meta.textMeta.descriptionResolved) {
		meta.textMeta.descriptionValue = getDistinctModelName(model);
		meta.textMeta.descriptionResolved = true;
	}
	return meta.textMeta.descriptionValue;
}

function getCachedSearchText(model: Model<Api>, meta: CachedModelMeta, isDefault: boolean): string {
	if (meta.textMeta.searchTextValue === undefined) {
		meta.textMeta.searchTextValue = getModelSelectorSearchText(model);
	}
	return isDefault ? `${meta.textMeta.searchTextValue} default` : meta.textMeta.searchTextValue;
}

function getCachedLabel(model: Model<Api>, meta: CachedModelMeta, level: ThinkingLevel | undefined): string {
	const effective = meta.reasoning ? level : undefined;
	let label = meta.labels.get(effective);
	if (label === undefined) {
		label = formatModelLabel(model, { thinkingLevel: effective });
		meta.labels.set(effective, label);
	}
	return label;
}

type ModelLevelResolver = (model: Model<Api>, meta: CachedModelMeta) => ThinkingLevel | undefined;

class ModelSelectorRow implements SelectorItem<Model<Api>> {
	readonly id: string;
	readonly value: Model<Api>;
	readonly mark: "on" | "off";
	readonly tag: "current" | "default" | undefined;
	readonly tagTone: "success" | "muted";
	readonly searchTextMode = "replace";
	private readonly meta: CachedModelMeta;
	private readonly isDefault: boolean;
	private readonly resolveLevel: ModelLevelResolver;
	private resolvedLabel?: string;

	constructor(
		model: Model<Api>,
		meta: CachedModelMeta,
		isCurrent: boolean,
		isDefault: boolean,
		resolveLevel: ModelLevelResolver,
	) {
		this.id = meta.key;
		this.value = model;
		this.meta = meta;
		this.mark = isCurrent ? "on" : "off";
		this.tag = isCurrent ? "current" : isDefault ? "default" : undefined;
		this.tagTone = isCurrent ? "success" : "muted";
		this.isDefault = isDefault;
		this.resolveLevel = resolveLevel;
	}

	get label(): string {
		this.resolvedLabel ??= getCachedLabel(this.value, this.meta, this.resolveLevel(this.value, this.meta));
		return this.resolvedLabel;
	}

	get description(): string | undefined {
		return getCachedDescription(this.value, this.meta);
	}

	get searchText(): string {
		return getCachedSearchText(this.value, this.meta, this.isDefault);
	}
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
	private items: SelectorItem<Model<Api>>[] = [];
	private readonly currentModel?: Model<Api>;
	private readonly currentModelKey?: string;
	private readonly thinkingContext: ModelSwitchThinkingContext;
	private readonly catalogStillCurrent?: () => boolean;
	private readonly defaultModelKey?: string;
	private readonly modelRuntime: ModelRuntime;
	private readonly tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope;
	private readonly chosenLevels = new Map<string, ThinkingLevel>();
	private readonly resolveRowLevel: ModelLevelResolver = (model, meta) => this.levelOf(model, meta);
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
		startupView?: { isCurrent(): boolean; settings: ModelSwitchThinkingContext["settings"] },
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
				if (!self || self.closed) return;
				const chosen = self.chosenLevels.get(item.id);
				const validChosen =
					chosen !== undefined && self.levelsFor(item.value).includes(chosen) ? chosen : undefined;
				self.dispose();
				if (validChosen !== undefined) onSelect(item.value, validChosen);
				else if (self.catalogStillCurrent && !self.catalogStillCurrent())
					onSelect(item.value, self.levelOf(item.value));
				else onSelect(item.value);
			},
			onCancel: () => {
				const self = holder.self;
				if (!self || self.closed) return;
				self.dispose();
				onCancel();
			},
			extraKeys: [
				{
					hint: { keys: "←→", label: "effort" },
					matches: (data) => effortDirection(data) !== 0,
					enabled: (item) => item !== undefined && (holder.self?.levelsFor(item.value).length ?? 0) > 1,
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
		this.currentModelKey = currentModel ? modelKey(currentModel) : undefined;
		this.catalogStillCurrent = startupView?.isCurrent;
		this.thinkingContext = {
			settings: startupView?.settings ?? settingsManager,
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
		this.rebuild(this.currentModelKey);
		this.tui.requestRender();
		void this.refreshModels();
	}

	override handleInput(data: string): void {
		if (this.closed) return;
		const direction = effortDirection(data);
		if (direction !== 0) {
			const item = this.selector.getSelected();
			if (item) this.stepLevel(item.value, direction);
			return;
		}
		super.handleInput(data);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		return super.handleMouse(event);
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.refreshAbortController.abort();
	}

	levelsFor(model: Model<Api>): ThinkingLevel[] {
		return model.reasoning ? (getSupportedThinkingLevels(model) as ThinkingLevel[]) : [];
	}

	private levelOf(model: Model<Api>, meta = getModelMeta(model)): ThinkingLevel | undefined {
		if (!meta.reasoning) return undefined;
		const chosen = this.chosenLevels.get(meta.key);
		return chosen !== undefined && this.levelsFor(model).includes(chosen)
			? chosen
			: thinkingLevelForModelSwitch(model, this.thinkingContext);
	}

	private stepLevel(model: Model<Api>, direction: 1 | -1): void {
		const meta = getModelMeta(model);
		const levels = this.levelsFor(model);
		if (levels.length <= 1) return;
		const current = this.levelOf(model, meta);
		const index = current === undefined ? -1 : levels.indexOf(current);
		const next = levels[Math.max(0, Math.min(levels.length - 1, (index < 0 ? 0 : index) + direction))];
		if (next === undefined || next === current) return;
		this.chosenLevels.set(meta.key, next);
		const itemIndex = this.items.findIndex((item) => item.id === meta.key);
		if (itemIndex >= 0) {
			const updated = this.items.slice();
			updated[itemIndex] = this.buildItem(model);
			this.items = updated;
			this.selector.setItems(this.items);
		} else {
			this.rebuild();
		}
	}

	private loadModelsFromSnapshot(): void {
		this.allModels = this.sortModels([...this.modelRuntime.getAvailableSnapshot()]);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelList = this.scopedModels.map((scoped) => scoped.model);
	}

	private sortModels(models: Model<Api>[]): Model<Api>[] {
		const current: Model<Api>[] = [];
		const defaults: Model<Api>[] = [];
		const remaining: Model<Api>[] = [];
		for (const model of models) {
			if (modelsAreEqual(this.currentModel, model)) current.push(model);
			else if (this.defaultModelKey !== undefined && modelKey(model) === this.defaultModelKey) defaults.push(model);
			else remaining.push(model);
		}
		remaining.sort((a, b) => compareProviders(a.provider, b.provider));
		return [...current, ...defaults, ...remaining];
	}

	private toggleScope(): void {
		if (this.scopedModelList.length === 0) return;
		this.scope = this.scope === "all" ? "scoped" : "all";
		this.selector.setQuery(this.selector.state.getQuery());
		this.rebuild(this.currentModelKey);
	}

	private reconcileChosenLevels(): void {
		if (this.chosenLevels.size === 0) return;
		const modelsByKey = new Map<string, Model<Api>>();
		for (const candidate of this.allModels) {
			const key = getModelMeta(candidate).key;
			if (!modelsByKey.has(key)) modelsByKey.set(key, candidate);
		}
		for (const candidate of this.scopedModelList) {
			const key = getModelMeta(candidate).key;
			if (!modelsByKey.has(key)) modelsByKey.set(key, candidate);
		}
		for (const [key, chosen] of [...this.chosenLevels.entries()]) {
			const model = modelsByKey.get(key);
			if (!model) {
				this.chosenLevels.delete(key);
				continue;
			}
			const levels = this.levelsFor(model);
			if (levels.length <= 1) {
				this.chosenLevels.delete(key);
				continue;
			}
			if (!levels.includes(chosen)) {
				const clamped = clampThinkingLevel(model, chosen) as ThinkingLevel;
				if (levels.includes(clamped)) this.chosenLevels.set(key, clamped);
				else this.chosenLevels.delete(key);
			}
		}
	}

	private buildItem(model: Model<Api>): SelectorItem<Model<Api>> {
		const meta = getModelMeta(model);
		const isCurrent = meta.key === this.currentModelKey && modelsAreEqual(this.currentModel, model);
		return new ModelSelectorRow(model, meta, isCurrent, meta.key === this.defaultModelKey, this.resolveRowLevel);
	}

	private rebuild(preferId?: string): void {
		this.reconcileChosenLevels();
		const models = this.scope === "scoped" ? this.scopedModelList : this.allModels;
		this.items = models.map((model) => this.buildItem(model));
		this.selector.setItems(this.items, this.selector.state.getQuery() ? undefined : preferId);
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
		if (!this.catalogStillCurrent || this.catalogStillCurrent()) {
			this.loadModelsFromSnapshot();
			this.rebuild(this.currentModel ? modelKey(this.currentModel) : undefined);
		}
		this.tui.requestRender();
	}
}
