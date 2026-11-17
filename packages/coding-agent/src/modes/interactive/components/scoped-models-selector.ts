import type { Api, Model } from "@bastani/atomic-ai/compat";
import { getKeybindings, type Input, matchesKey } from "@bastani/atomic-tui";
import { formatModelLabel } from "../../../core/model-label.ts";
import { getDistinctModelName, getModelSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.js";
import { navActionText } from "./nav-keys.ts";
import { FramedSelector, type SelectorExtraKey, type SelectorItem, type SelectorTone } from "./selector.ts";

// EnabledIds: null = all enabled (no filter), string[] = explicit ordered list
type EnabledIds = string[] | null;

function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

/** Collapse an explicit list back to null (= all enabled) when it covers every available model. */
function normalizeEnabled(result: string[], allIds: string[]): EnabledIds {
	if (result.length !== allIds.length) return result;
	const allSet = new Set(allIds);
	return result.every((id) => allSet.has(id)) ? null : result;
}

function toggle(enabledIds: EnabledIds, allIds: string[], id: string): EnabledIds {
	if (enabledIds === null) return allIds.filter((modelId) => modelId !== id);
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return normalizeEnabled([...enabledIds, id], allIds);
}

function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null; // Already all enabled
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	const seen = new Set(result);
	for (const id of targets) {
		if (!seen.has(id)) {
			seen.add(id);
			result.push(id);
		}
	}
	return normalizeEnabled(result, allIds);
}

function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (targetIds !== undefined && targetIds.length === 0) return enabledIds;
	if (enabledIds === null) {
		if (!targetIds) return [];
		const targets = new Set(targetIds);
		const remaining = allIds.filter((id) => !targets.has(id));
		return remaining.length === allIds.length ? null : remaining;
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

function sameEnabledIds(left: EnabledIds, right: EnabledIds): boolean {
	if (left === right) return true;
	if (left === null || right === null || left.length !== right.length) return false;
	return left.every((id, index) => id === right[index]);
}

function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const list = [...enabledIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

function getSortedIds(enabledIds: EnabledIds, allIds: string[], enabledSet?: ReadonlySet<string>): string[] {
	if (enabledIds === null) return allIds;
	const lookup = enabledSet ?? new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !lookup.has(id))];
}

interface ScopedModelMetadata {
	descriptionResolved: boolean;
	descriptionValue: string | undefined;
	searchTextValue: string | undefined;
}

const UNAVAILABLE_LABEL_STYLE = (text: string, selected: boolean): string =>
	selected ? theme.fg("accent", theme.strikethrough(text)) : theme.strikethrough(text);

interface ScopedModelRowHost {
	resolveLabel(id: string, model: Model<Api> | undefined): string;
	resolveDescription(id: string, model: Model<Api> | undefined): string | undefined;
	resolveSearchText(id: string, model: Model<Api> | undefined): string;
}

class ScopedModelRow implements SelectorItem<string> {
	readonly id: string;
	readonly value: string;
	readonly mark: "checked" | "unchecked";
	readonly tag: "unavailable" | undefined;
	readonly searchTextMode = "replace";
	readonly labelStyle: ((label: string, selected: boolean) => string) | undefined;
	private readonly model: Model<Api> | undefined;
	private readonly host: ScopedModelRowHost;
	private resolvedLabel?: string;

	constructor(id: string, model: Model<Api> | undefined, enabled: boolean, host: ScopedModelRowHost) {
		this.id = id;
		this.value = id;
		this.model = model;
		this.mark = enabled ? "checked" : "unchecked";
		this.tag = model ? undefined : "unavailable";
		this.labelStyle = model ? undefined : UNAVAILABLE_LABEL_STYLE;
		this.host = host;
	}

	get label(): string {
		this.resolvedLabel ??= this.host.resolveLabel(this.id, this.model);
		return this.resolvedLabel;
	}

	get description(): string | undefined {
		return this.host.resolveDescription(this.id, this.model);
	}

	get searchText(): string {
		return this.host.resolveSearchText(this.id, this.model);
	}
}

export interface ModelsConfig {
	allModels: readonly Model<Api>[];
	enabledModelIds: string[] | null;
	refreshStatus?: string;
	/** The level a model runs at when cycled to, shown after its ID (#4269). Without it rows show the ID alone. */
	thinkingLevelFor?: (model: Model<Api>) => string | undefined;
}

export interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes. */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

export class ScopedModelsSelectorComponent extends FramedSelector<string> implements ScopedModelRowHost {
	private modelsById: Map<string, Model<Api>> = new Map();
	private readonly modelMetadata = new Map<string, ScopedModelMetadata>();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private readonly callbacks: ModelsCallbacks;
	private readonly thinkingLevelFor: ModelsConfig["thinkingLevelFor"];
	private changeQueue: Promise<void> | undefined;
	private refreshNotice: { text: string; tone: SelectorTone } | undefined;
	private changeErrorShown = false;

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		let reorderDelta = 0;
		let reorderTargetId: string | undefined;
		const self = (): ScopedModelsSelectorComponent => this;
		const extraKeys: SelectorExtraKey<string>[] = [
			{
				hint: { action: "app.models.enableAll", label: "all" },
				enabled: () => self().canSetAll(true),
				run: () => self().setAll(true),
			},
			{
				hint: { action: "app.models.clearAll", label: "clear" },
				enabled: () => self().canSetAll(false),
				run: () => self().setAll(false),
			},
			{
				hint: { action: "app.models.toggleProvider", label: "provider" },
				enabled: (item) => item !== undefined && self().modelsById.has(item.value),
				run: (item) => item && self().toggleProvider(item.value),
			},
			{
				hint: {
					get keys() {
						return self().reorderHintKeys(reorderTargetId ?? self().selector?.getSelected()?.value);
					},
					label: "reorder",
				},
				matches: (data) => {
					const activeKb = getKeybindings();
					reorderDelta = activeKb.matches(data, "app.models.reorderUp")
						? -1
						: activeKb.matches(data, "app.models.reorderDown")
							? 1
							: 0;
					return reorderDelta !== 0;
				},
				enabled: (item) => {
					reorderTargetId = item?.value;
					return item !== undefined && self().canReorder(item.value);
				},
				run: (item) => item && self().reorder(item.value, reorderDelta),
			},
		];
		super({
			title: "Scoped models",
			search: true,
			items: [],
			maxVisible: 8,
			emptyText: "No models available",
			confirmLabel: "toggle",
			closeOnSelect: false,
			extraKeys,
			onSelect: (item) => self().toggleModel(item.value),
			onCancel: callbacks.onCancel,
		});
		this.callbacks = callbacks;
		this.thinkingLevelFor = config.thinkingLevelFor;
		this.enabledIds = config.enabledModelIds === null ? null : [...new Set(config.enabledModelIds)];
		this.setModels(config.allModels);
		if (config.refreshStatus) this.setRefreshStatus(config.refreshStatus, "muted");
		this.refresh();
	}

	updateModels(models: readonly Model<Api>[], enabledModelIds?: string[] | null): void {
		if (enabledModelIds !== undefined) {
			this.enabledIds = enabledModelIds === null ? null : [...new Set(enabledModelIds)];
		}
		this.setModels(models);
		this.refresh();
	}

	setRefreshStatus(message: string, kind: "muted" | "success" | "warning"): void {
		this.refreshNotice = { text: message, tone: kind satisfies SelectorTone };
		this.changeErrorShown = false;
		this.selector.setNotice(this.refreshNotice);
	}

	getSearchInput(): Input {
		const input = this.selector.getSearchInput();
		if (!input) throw new Error("The scoped models picker always has a search box");
		return input;
	}

	override handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") && this.selector.state.getQuery()) {
			this.selector.clearSearch();
			return;
		}
		super.handleInput(data);
	}

	resolveLabel(id: string, model: Model<Api> | undefined): string {
		return model ? formatModelLabel(model, { thinkingLevel: this.thinkingLevelFor?.(model) }) : id;
	}

	resolveDescription(id: string, model: Model<Api> | undefined): string | undefined {
		if (!model) return undefined;
		const meta = this.getOrCreateMetadata(id);
		if (!meta.descriptionResolved) {
			meta.descriptionValue = getDistinctModelName(model);
			meta.descriptionResolved = true;
		}
		return meta.descriptionValue;
	}

	resolveSearchText(id: string, model: Model<Api> | undefined): string {
		if (!model) return id;
		const meta = this.getOrCreateMetadata(id);
		meta.searchTextValue ??= getModelSearchText(model);
		return meta.searchTextValue;
	}

	private getOrCreateMetadata(id: string): ScopedModelMetadata {
		let meta = this.modelMetadata.get(id);
		if (!meta) {
			meta = { descriptionResolved: false, descriptionValue: undefined, searchTextValue: undefined };
			this.modelMetadata.set(id, meta);
		}
		return meta;
	}

	private setModels(models: readonly Model<Api>[]): void {
		this.modelsById.clear();
		this.modelMetadata.clear();
		this.allIds = [];
		for (const model of models) {
			const fullId = `${model.provider}/${model.id}`;
			if (!this.modelsById.has(fullId)) {
				this.allIds.push(fullId);
			}
			this.modelsById.set(fullId, model);
		}
	}

	private buildItems(): SelectorItem<string>[] {
		const enabledIds = this.enabledIds === null ? undefined : new Set(this.enabledIds);
		return getSortedIds(this.enabledIds, this.allIds, enabledIds).map(
			(id) => new ScopedModelRow(id, this.modelsById.get(id), enabledIds === undefined || enabledIds.has(id), this),
		);
	}

	private countText(): string {
		if (this.enabledIds === null) return "all enabled";
		const enabledCount = this.enabledIds.filter((id) => this.modelsById.has(id)).length;
		const unavailableCount = this.enabledIds.length - enabledCount;
		return `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
	}

	private refresh(keepPosition = false): void {
		const position = this.selector.state.getSelectedIndex();
		this.selector.setItems(this.buildItems());
		if (keepPosition) this.selector.state.select(position);
		this.selector.setSubtitle(`Changes are saved automatically · ${this.countText()}`);
	}

	private change(enabledIds: EnabledIds, keepPosition = false): void {
		if (sameEnabledIds(this.enabledIds, enabledIds)) return;
		this.enabledIds = enabledIds;
		this.refresh(keepPosition);
		this.enqueueChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	private enqueueChange(snapshot: EnabledIds): void {
		const payload = (): EnabledIds => (snapshot === null ? null : [...snapshot]);
		const handleFailure = (error: unknown): void => {
			const detail = error instanceof Error ? error.message : String(error);
			this.changeErrorShown = true;
			this.selector.setNotice({ text: detail || "Failed to save scoped models.", tone: "error" });
		};
		const clearFailure = (): void => {
			if (!this.changeErrorShown) return;
			this.changeErrorShown = false;
			this.selector.setNotice(this.refreshNotice);
		};
		const invoke = (): Promise<void> | undefined => {
			try {
				const result = this.callbacks.onChange(payload());
				if (result && typeof result.then === "function") {
					return Promise.resolve(result).then(clearFailure, handleFailure);
				}
				clearFailure();
				return undefined;
			} catch (error) {
				handleFailure(error);
				return undefined;
			}
		};

		if (!this.changeQueue) {
			const pending = invoke();
			if (pending) {
				const tracked = pending.finally(() => {
					if (this.changeQueue === tracked) {
						this.changeQueue = undefined;
					}
				});
				this.changeQueue = tracked;
			}
			return;
		}

		const next = this.changeQueue.then(async () => {
			await invoke();
		});
		const tracked = next.finally(() => {
			if (this.changeQueue === tracked) {
				this.changeQueue = undefined;
			}
		});
		this.changeQueue = tracked;
	}

	private toggleModel(id: string): void {
		this.change(toggle(this.enabledIds, this.allIds, id), true);
	}

	private getTargetIds(): string[] | undefined {
		return this.selector.state.getQuery() ? this.selector.state.getVisible().map((item) => item.value) : undefined;
	}

	private nextSetAll(enable: boolean): EnabledIds {
		const targetIds = this.getTargetIds();
		if (enable) return enableAll(this.enabledIds, this.allIds, targetIds);
		if (this.allIds.length === 0 && (this.enabledIds === null || this.enabledIds.length === 0)) {
			return this.enabledIds;
		}
		return clearAll(this.enabledIds, this.allIds, targetIds);
	}

	private canSetAll(enable: boolean): boolean {
		return !sameEnabledIds(this.enabledIds, this.nextSetAll(enable));
	}

	private setAll(enable: boolean): void {
		this.change(this.nextSetAll(enable), true);
	}

	private toggleProvider(id: string): void {
		const provider = this.modelsById.get(id)?.provider;
		if (provider === undefined) return;
		const providerIds = this.allIds.filter((modelId) => this.modelsById.get(modelId)?.provider === provider);
		const allEnabled = providerIds.every((modelId) => isEnabled(this.enabledIds, modelId));
		this.change(
			allEnabled
				? clearAll(this.enabledIds, this.allIds, providerIds)
				: enableAll(this.enabledIds, this.allIds, providerIds),
			true,
		);
	}

	private canReorderDelta(id: string, delta: number): boolean {
		if (this.enabledIds === null || delta === 0) return false;
		const index = this.enabledIds.indexOf(id);
		if (index < 0) return false;
		const newIndex = index + delta;
		return newIndex >= 0 && newIndex < this.enabledIds.length;
	}

	private canReorder(id: string): boolean {
		return this.canReorderDelta(id, -1) || this.canReorderDelta(id, 1);
	}

	private reorderHintKeys(id: string | undefined): string {
		if (id === undefined) return "";
		const kb = getKeybindings();
		const keys: string[] = [];
		if (this.canReorderDelta(id, -1)) keys.push(navActionText(kb, "app.models.reorderUp"));
		if (this.canReorderDelta(id, 1)) keys.push(navActionText(kb, "app.models.reorderDown"));
		return keys.filter(Boolean).join("/");
	}

	private reorder(id: string, delta: number): void {
		if (!this.canReorderDelta(id, delta)) return;
		this.change(move(this.enabledIds, id, delta));
	}
}
