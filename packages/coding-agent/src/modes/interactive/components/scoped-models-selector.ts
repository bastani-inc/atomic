import type { Api, Model } from "@bastani/atomic-ai/compat";
import { getKeybindings, type Input } from "@bastani/atomic-tui";
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
	return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
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
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return normalizeEnabled(result, allIds);
}

function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
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

function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
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

/**
 * The `/scoped-models` picker: which models Ctrl+P cycles through, and in what order. Enter switches the selected
 * model on or off; changes are saved automatically by the caller.
 */
export class ScopedModelsSelectorComponent extends FramedSelector<string> {
	private modelsById: Map<string, Model<Api>> = new Map();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private readonly callbacks: ModelsCallbacks;
	private readonly thinkingLevelFor: ModelsConfig["thinkingLevelFor"];

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		const kb = getKeybindings();
		// Set by the reorder key's matcher, read by its action: which way the pressed key moves the model.
		let reorderDelta = 0;
		const self = (): ScopedModelsSelectorComponent => this;
		const extraKeys: SelectorExtraKey<string>[] = [
			{ hint: { action: "app.models.enableAll", label: "all" }, run: () => self().setAll(true) },
			{ hint: { action: "app.models.clearAll", label: "clear" }, run: () => self().setAll(false) },
			{
				hint: { action: "app.models.toggleProvider", label: "provider" },
				enabled: (item) => item !== undefined && self().modelsById.has(item.value),
				run: (item) => item && self().toggleProvider(item.value),
			},
			{
				hint: {
					keys: [navActionText(kb, "app.models.reorderUp"), navActionText(kb, "app.models.reorderDown")]
						.filter(Boolean)
						.join("/"),
					label: "reorder",
				},
				matches: (data) => {
					reorderDelta = kb.matches(data, "app.models.reorderUp")
						? -1
						: kb.matches(data, "app.models.reorderDown")
							? 1
							: 0;
					return reorderDelta !== 0;
				},
				enabled: (item) => item !== undefined && self().enabledIds?.includes(item.value) === true,
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
			extraKeys,
			onSelect: (item) => self().toggleModel(item.value),
			onCancel: callbacks.onCancel,
		});
		this.callbacks = callbacks;
		this.thinkingLevelFor = config.thinkingLevelFor;
		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
		this.setModels(config.allModels);
		if (config.refreshStatus) this.setRefreshStatus(config.refreshStatus, "muted");
		this.refresh();
	}

	updateModels(models: readonly Model<Api>[], enabledModelIds?: string[] | null): void {
		if (enabledModelIds !== undefined) this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
		this.setModels(models);
		this.refresh();
	}

	setRefreshStatus(message: string, kind: "muted" | "success" | "warning"): void {
		this.selector.setNotice({ text: message, tone: kind satisfies SelectorTone });
	}

	getSearchInput(): Input {
		const input = this.selector.getSearchInput();
		if (!input) throw new Error("The scoped models picker always has a search box");
		return input;
	}

	override handleInput(data: string): void {
		// Ctrl+C clears a search before it closes the picker, as it always has here.
		if (data === "\x03" && this.selector.state.getQuery()) {
			this.selector.clearSearch();
			return;
		}
		super.handleInput(data);
	}

	private setModels(models: readonly Model<Api>[]): void {
		this.modelsById.clear();
		this.allIds = [];
		for (const model of models) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}
	}

	private buildItems(): SelectorItem<string>[] {
		// Rows show the raw ID and level, exactly what `enabledModels` and `--models` take (#4269); a display name that
		// adds words the ID lacks follows in a dim column.
		return getSortedIds(this.enabledIds, this.allIds).map((id) => {
			const model = this.modelsById.get(id);
			const enabled = model !== undefined && isEnabled(this.enabledIds, id);
			return {
				id,
				value: id,
				label: model ? formatModelLabel(model, { thinkingLevel: this.thinkingLevelFor?.(model) }) : id,
				description: model ? getDistinctModelName(model) : undefined,
				mark: enabled || (!model && isEnabled(this.enabledIds, id)) ? "checked" : "unchecked",
				tag: model ? undefined : "unavailable",
				searchText: model ? getModelSearchText({ id: model.id, provider: model.provider, name: model.name }) : id,
				labelStyle: model
					? undefined
					: (text, selected) =>
							selected ? theme.fg("accent", theme.strikethrough(text)) : theme.strikethrough(text),
			};
		});
	}

	private countText(): string {
		if (this.enabledIds === null) return "all enabled";
		const enabledCount = this.enabledIds.filter((id) => this.modelsById.has(id)).length;
		const unavailableCount = this.enabledIds.length - enabledCount;
		return `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
	}

	/** Rebuild the rows; the browsed model stays selected unless `keepPosition` keeps the row position instead. */
	private refresh(keepPosition = false): void {
		const position = this.selector.state.getSelectedIndex();
		this.selector.setItems(this.buildItems());
		if (keepPosition) this.selector.state.select(position);
		this.selector.setSubtitle(`Changes are saved automatically · ${this.countText()}`);
	}

	private change(enabledIds: EnabledIds, keepPosition = false): void {
		this.enabledIds = enabledIds;
		this.refresh(keepPosition);
		this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	private toggleModel(id: string): void {
		this.change(toggle(this.enabledIds, this.allIds, id), true);
	}

	/** Enable or clear every model, or only the matching ones while searching. */
	private setAll(enable: boolean): void {
		const targetIds = this.selector.state.getQuery()
			? this.selector.state.getVisible().map((item) => item.value)
			: undefined;
		this.change(
			enable
				? enableAll(this.enabledIds, this.allIds, targetIds)
				: clearAll(this.enabledIds, this.allIds, targetIds),
			true,
		);
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

	private reorder(id: string, delta: number): void {
		if (this.enabledIds === null) return;
		const newIndex = this.enabledIds.indexOf(id) + delta;
		// Only move within the enabled list.
		if (newIndex < 0 || newIndex >= this.enabledIds.length) return;
		this.change(move(this.enabledIds, id, delta));
	}
}
