import {
	Container,
	type Focusable,
	fuzzyFilter,
	getSelectPageIndex,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@bastani/atomic-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import {
	type NavKey,
	navActionText,
	navFirstKeyText,
	renderNavHintLine,
} from "../../modes/interactive/components/nav-keys.ts";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { HuggingFaceModel } from "./huggingface.js";

function compactCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	return String(value);
}

const SEARCH_MAX_VISIBLE = 10;

export class HuggingFaceSearch extends Container implements Focusable {
	readonly capturesViewportInput: boolean = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>;
	private readonly cache: Map<string, HuggingFaceModel[]>;
	private readonly onSelectModel: (model: string | undefined) => void;
	private readonly input: Input;
	private readonly resultsContainer = new Container();
	private results: HuggingFaceModel[] = [];
	private filteredResults: HuggingFaceModel[] = [];
	private selectedIndex = 0;
	// Whether the user moved the selection since the query last changed.
	private selectionTouched = false;
	private query = "";
	private status = "Type at least 2 characters";
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private request: AbortController | undefined;
	private closed = false;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
		cache: Map<string, HuggingFaceModel[]>,
		onSelectModel: (model: string | undefined) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.search = search;
		this.cache = cache;
		this.onSelectModel = onSelectModel;
		this.input = new Input({
			prompt: "⌕ ",
			placeholder: "Model name or owner/repository[:quant]",
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.resultsContainer);
		this.addChild(new Spacer(1));
		this.addChild({
			render: (width: number) => [
				renderNavHintLine(this.hintEntries(), width, this.hintStyle(), this.keybindings, 1),
			],
			invalidate: () => {},
		});
		this.updateResults();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private updateResults(): void {
		this.resultsContainer.clear();
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(SEARCH_MAX_VISIBLE / 2),
				this.filteredResults.length - SEARCH_MAX_VISIBLE,
			),
		);
		const end = Math.min(start + SEARCH_MAX_VISIBLE, this.filteredResults.length);
		for (let index = start; index < end; index++) {
			const model = this.filteredResults[index];
			if (!model) continue;
			const prefix = index === this.selectedIndex ? "∀ " : "  ";
			const details = `${compactCount(model.downloads)} downloads`;
			this.resultsContainer.addChild(
				new Text(
					index === this.selectedIndex
						? this.theme.fg("accent", `${prefix}${model.id}  ${details}`)
						: `${prefix}${model.id}${this.theme.fg("muted", `  ${details}`)}`,
					0,
					0,
				),
			);
		}
		const above = start;
		const below = this.filteredResults.length - end;
		if (above > 0 || below > 0) {
			const parts = [above > 0 ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(Boolean);
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${parts.join(" · ")}`), 0, 0));
		}
		if (this.filteredResults.length === 0) {
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${this.status}`), 0, 0));
		} else if (this.status === "Searching Hugging Face…") {
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${this.status}`), 0, 0));
		}
		this.tui.requestRender();
	}

	private hintStyle() {
		return {
			dim: (text: string) => this.theme.fg("dim", text),
			text: (text: string) => this.theme.fg("text", text),
			muted: (text: string) => this.theme.fg("muted", text),
			border: (text: string) => this.theme.fg("borderMuted", text),
			bold: (text: string) => this.theme.bold(text),
		};
	}

	private exactQuery(): string | undefined {
		return /^[^/\s]+\/[^:\s]+(?::[^\s:]+)?$/u.test(this.query) ? this.query : undefined;
	}

	private hintEntries(): NavKey[] {
		const entries: NavKey[] = [];
		if (this.filteredResults.length > 1) {
			const up = navActionText(this.keybindings, "tui.select.up");
			const down = navActionText(this.keybindings, "tui.select.down");
			entries.push({ keys: up === "↑" && down === "↓" ? "↑↓" : `${up}/${down}`, label: "select" });
		}
		if (this.exactQuery() !== undefined || this.filteredResults[this.selectedIndex] !== undefined) {
			entries.push({ action: "tui.select.confirm", label: "download" });
		}
		entries.push({ keys: "type", label: "to search" });
		entries.push({
			keys: navFirstKeyText(this.keybindings, "tui.select.cancel") || "esc",
			label: "back",
		});
		return entries;
	}

	private filterResults(preferredId?: string): void {
		if (this.query) {
			const matches = new Set(fuzzyFilter(this.results, this.query, (model) => model.id).map((model) => model.id));
			this.filteredResults = this.results.filter((model) => matches.has(model.id));
		} else {
			this.filteredResults = this.results;
		}
		const preferredIndex = preferredId ? this.filteredResults.findIndex((model) => model.id === preferredId) : -1;
		if (preferredIndex >= 0) this.selectedIndex = preferredIndex;
		else this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredResults.length - 1));
		this.updateResults();
	}

	private scheduleSearch(): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.request?.abort();
		this.request = undefined;
		if (this.query.length < 2) {
			this.status = "Type at least 2 characters";
			this.filterResults();
			return;
		}
		const cached = this.cache.get(this.query.toLowerCase());
		if (cached) {
			this.results = cached;
			this.status = cached.length === 0 ? "No GGUF models found" : "";
			this.filterResults();
			return;
		}
		this.status = "Searching Hugging Face…";
		this.filterResults();
		this.debounce = setTimeout(() => void this.runSearch(this.query), 500);
	}

	private async runSearch(query: string): Promise<void> {
		const request = new AbortController();
		this.request = request;
		try {
			const results = await this.search(query, request.signal);
			this.cache.set(query.toLowerCase(), results);
			if (this.closed || request.signal.aborted || this.query !== query) return;
			// Keep the row the user browsed to while the search was in flight; otherwise show the best match.
			const selectedId = this.selectionTouched ? this.filteredResults[this.selectedIndex]?.id : undefined;
			this.results = results;
			this.selectedIndex = 0;
			this.status = results.length === 0 ? "No GGUF models found" : "";
			this.filterResults(selectedId);
		} catch (error) {
			if (this.closed || request.signal.aborted || this.query !== query) return;
			this.results = [];
			this.status = error instanceof Error ? error.message : String(error);
			this.filterResults();
		} finally {
			if (this.request === request) this.request = undefined;
		}
	}

	private close(model: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		if (this.debounce) clearTimeout(this.debounce);
		this.request?.abort();
		this.onSelectModel(model);
	}

	handleInput(data: string): boolean {
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.filteredResults.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredResults.length - 1 : this.selectedIndex - 1;
				this.selectionTouched = true;
				this.updateResults();
			}
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.filteredResults.length > 0) {
				this.selectedIndex = this.selectedIndex === this.filteredResults.length - 1 ? 0 : this.selectedIndex + 1;
				this.selectionTouched = true;
				this.updateResults();
			}
			return true;
		}
		const pageIndex = getSelectPageIndex(
			this.keybindings,
			data,
			this.selectedIndex,
			this.filteredResults.length,
			SEARCH_MAX_VISIBLE,
		);
		if (pageIndex !== undefined) {
			if (this.filteredResults.length > 0) {
				this.selectedIndex = pageIndex;
				this.selectionTouched = true;
				this.updateResults();
			}
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.exactQuery() ?? this.filteredResults[this.selectedIndex]?.id;
			if (selected) this.close(selected);
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.close(undefined);
			return true;
		}
		this.input.handleInput(data);
		const query = this.input.getValue().trim();
		if (query === this.query) return true;
		this.query = query;
		this.selectionTouched = false;
		this.scheduleSearch();
		return true;
	}
}
