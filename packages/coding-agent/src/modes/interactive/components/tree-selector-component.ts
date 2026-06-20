import { Container, type Focusable, Spacer, Text } from "@earendil-works/pi-tui";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { SearchLine, TreeHelp } from "./tree-selector-help.ts";
import { LabelInput } from "./tree-selector-label-input.ts";
import { TreeList } from "./tree-selector-list.ts";
import type { FilterMode } from "./tree-selector-types.ts";

/** Component that renders a session tree selector for navigation */
export class TreeSelectorComponent extends Container implements Focusable {
	private treeList: TreeList;
	private labelInput: LabelInput | null = null;
	private labelInputContainer: Container;
	private treeContainer: Container;
	private onLabelChangeCallback?: (entryId: string, label: string | undefined) => void;

	// Focusable implementation - propagate to labelInput when active for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		// Propagate to labelInput when it's active
		if (this.labelInput) {
			this.labelInput.focused = value;
		}
	}

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		onLabelChange?: (entryId: string, label: string | undefined) => void,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		super();

		this.onLabelChangeCallback = onLabelChange;
		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode);
		this.treeList.onSelect = onSelect;
		this.treeList.onCancel = onCancel;
		this.treeList.onLabelEdit = (entryId, currentLabel) => this.showLabelInput(entryId, currentLabel);

		this.treeContainer = new Container();
		this.treeContainer.addChild(this.treeList);

		this.labelInputContainer = new Container();

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Session Tree"), 1, 0));
		this.addChild(new TreeHelp());
		this.addChild(new SearchLine(this.treeList));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.treeContainer);
		this.addChild(this.labelInputContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	private showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.labelInput = new LabelInput(entryId, currentLabel);
		this.labelInput.onSubmit = (id, label) => {
			this.treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.hideLabelInput();
		};
		this.labelInput.onCancel = () => this.hideLabelInput();

		// Propagate current focused state to the new labelInput
		this.labelInput.focused = this._focused;

		this.treeContainer.clear();
		this.labelInputContainer.clear();
		this.labelInputContainer.addChild(this.labelInput);
	}

	private hideLabelInput(): void {
		this.labelInput = null;
		this.labelInputContainer.clear();
		this.treeContainer.clear();
		this.treeContainer.addChild(this.treeList);
	}

	handleInput(keyData: string): void {
		if (this.labelInput) {
			this.labelInput.handleInput(keyData);
		} else {
			this.treeList.handleInput(keyData);
		}
	}

	getTreeList(): TreeList {
		return this.treeList;
	}
}
