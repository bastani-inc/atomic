import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import { persistProviderModelDefault } from "../../../core/provider-model-default.ts";
import { isOfflineModeEnabled } from "../../../core/package-manager-env.ts";
import { providerModelsAreExactlyEqual } from "../../../core/provider-model-reference.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<Api>;
}

interface ScopedModelItem {
	model: Model<Api>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "scoped";

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<Api>;
	private settingsManager: SettingsManager;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<Api>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private readonly refreshAbortController = new AbortController();
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<Api> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<Api>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Show the current snapshot first, then prepare exact providers and refresh ordinary catalogs.
		void this.loadModelsFromSnapshot()
			.then(() => {
				if (initialSearchInput) this.filterModels(initialSearchInput);
				else this.updateList();
				this.tui.requestRender();
				return this.refreshModels();
			})
			.catch((error) => {
				if (this.closed) return;
				this.refreshStatusSuccess = false;
				this.refreshStatusMessage = `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
				this.tui.requestRender();
			});
	}

	private async loadModelsFromSnapshot(): Promise<void> {
		this.errorMessage = undefined;
		let models: ModelItem[];

		// Check for models.json errors
		const loadError = this.modelRegistry.getError();
		if (loadError) {
			this.errorMessage = loadError;
		}

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = await this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<Api>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRegistry.getAll().find((candidate) => providerModelsAreExactlyEqual(candidate, scoped.model));
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => providerModelsAreExactlyEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private async refreshModels(): Promise<void> {
		let preparationError: Error | undefined;
		if (typeof this.modelRegistry.prepareRequiredProviders === "function") {
			try {
				await this.modelRegistry.prepareRequiredProviders({
					allowNetwork: !isOfflineModeEnabled(),
					signal: this.refreshAbortController.signal,
					timeoutMs: 15_000,
				});
			} catch (error) {
				preparationError = error instanceof Error ? error : new Error(String(error));
			}
		}
		const result = await this.modelRegistry.refresh({
			allowNetwork: !isOfflineModeEnabled(),
			signal: this.refreshAbortController.signal,
			timeoutMs: 15_000,
			skipRequiredProviderExtensions: true,
		});
		if (this.closed) return;
		this.refreshStatusSuccess = false;
		if (preparationError) {
			this.refreshStatusMessage = `Could not prepare required model catalogs: ${preparationError.message}; showing available models.`;
		} else if (result.aborted) {
			this.refreshStatusMessage = "Model refresh timed out; showing cached models.";
		} else if (result.errors.size === 1) {
			this.refreshStatusMessage = `Could not refresh ${result.errors.keys().next().value}; showing available models.`;
		} else if (result.errors.size > 1) {
			this.refreshStatusMessage = `Could not refresh ${result.errors.size} model catalogs; showing available models.`;
		} else {
			this.refreshStatusMessage = "Model catalogs refreshed.";
			this.refreshStatusSuccess = true;
		}
		await this.loadModelsFromSnapshot();
		this.filterModels(this.searchInput.getValue());
		this.tui.requestRender();
	}

	private close(): void {
		this.closed = true;
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, then by provider
		sorted.sort((a, b) => {
			const aIsCurrent = providerModelsAreExactlyEqual(this.currentModel, a.model);
			const bIsCurrent = providerModelsAreExactlyEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => providerModelsAreExactlyEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.activeModels, query, ({ id, provider, model }) =>
					getModelSelectorSearchText({ id, provider, name: model.name }),
				)
			: this.activeModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = providerModelsAreExactlyEqual(this.currentModel, item.model);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = item.model.name === item.id ? item.id : `${item.id} · ${item.model.name}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${prefix + theme.fg("accent", modelText)} ${providerBadge}${checkmark}`;
			} else {
				const modelText = `  ${item.model.name === item.id ? item.id : `${item.id} · ${item.model.name}`}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${modelText} ${providerBadge}${checkmark}`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			const color = this.refreshStatusSuccess ? "success" : "warning";
			this.listContainer.addChild(new Text(theme.fg(color, `  ${this.refreshStatusMessage}`), 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.close();
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<Api>): void {
		this.close();
		// Save as new default
		persistProviderModelDefault(this.settingsManager, this.modelRegistry, model);
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
