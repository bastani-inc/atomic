import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };
const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

export class ThinkingSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList;
	private selectListChildIndex: number;
	private allItems: SelectItem[];
	private readonly onSelectLevel: (level: ThinkingLevel) => void;
	private readonly onCancelSelect: () => void;
	private readonly onSelectAsDefault?: (level: ThinkingLevel) => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelectLevel: (level: ThinkingLevel) => void,
		onCancelSelect: () => void,
		onSelectAsDefault?: (level: ThinkingLevel) => void,
		defaultThinkingLevel?: ThinkingLevel,
	) {
		super();
		this.onSelectLevel = onSelectLevel;
		this.onCancelSelect = onCancelSelect;
		this.onSelectAsDefault = onSelectAsDefault;
		this.allItems = availableLevels.map((level) => ({
			value: level,
			label: `${level === currentLevel ? "✓ " : "  "}${level}`,
			description:
				level === defaultThinkingLevel ? `${LEVEL_DESCRIPTIONS[level]} · default` : LEVEL_DESCRIPTIONS[level],
		}));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text("Thinking Level", 0, 0));
		this.addChild(new Text(`${keyDisplayText("app.thinking.cycle")} cycles thinking levels in-session`, 0, 0));
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.buildSelectList(this.allItems, currentLevel);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${keyDisplayText("tui.select.confirm")} to select · ${keyDisplayText("app.thinking.save")} to set as default · ${keyDisplayText("tui.select.cancel")} to cancel`,
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}

	private buildSelectList(items: SelectItem[], preselect?: ThinkingLevel): SelectList {
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), THINKING_SELECT_LIST_LAYOUT);
		const index = items.findIndex((item) => item.value === preselect);
		if (index !== -1) list.setSelectedIndex(index);
		list.onSelect = (item) => this.onSelectLevel(item.value as ThinkingLevel);
		list.onCancel = () => this.onCancelSelect();
		return list;
	}

	private applyFilter(query: string): void {
		const items = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`)
			: this.allItems;
		const selected = this.selectList.getSelectedItem()?.value as ThinkingLevel | undefined;
		const list = this.buildSelectList(items, selected);
		this.children[this.selectListChildIndex] = list;
		this.selectList = list;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.thinking.save") && this.onSelectAsDefault) {
			const item = this.selectList.getSelectedItem();
			if (item) this.onSelectAsDefault(item.value as ThinkingLevel);
			return;
		}
		if (
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel")
		) {
			this.selectList.handleInput(keyData);
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
