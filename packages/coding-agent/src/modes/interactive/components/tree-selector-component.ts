import { Container, type Focusable, getKeybindings, Spacer, Text } from "@bastani/atomic-tui";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.ts";
import type { StoredTreeView } from "./stored-tree-view.js";
import { SearchLine, TreeHelp } from "./tree-selector-help.ts";
import { LabelInput } from "./tree-selector-label-input.ts";
import { TreeList } from "./tree-selector-list.ts";
import type { FilterMode } from "./tree-selector-types.ts";

/** Component that renders a session tree selector for navigation */
export class TreeSelectorComponent extends Container implements Focusable {
	private treeList: TreeList;
	private searchLine: SearchLine;
	private labelInput: LabelInput | null = null;
	private labelInputContainer: Container;
	private treeContainer: Container;
	private onLabelChangeCallback?: (entryId: string, label: string | undefined) => void | Promise<void>;
	private labelPending = false;
	// Reading the whole of a stored label before the input opens with it; Escape abandons the read.
	private labelLoad?: AbortController;
	private readonly archive?: StoredTreeView;
	public onLabelError?: (error: Error) => void;
	public onLabelUpdate?: () => void;

	// Focusable implementation - propagate to the active input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchLine.focused = value && this.labelInput === null;
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
		onLabelChange?: (entryId: string, label: string | undefined) => void | Promise<void>,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
		archive?: StoredTreeView,
	) {
		super();

		this.onLabelChangeCallback = onLabelChange;
		this.archive = archive;
		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode, archive);
		this.treeList.onSelect = onSelect;
		this.treeList.onCancel = onCancel;
		this.treeList.onLabelEdit = (entryId, currentLabel) => this.editLabel(entryId, currentLabel);
		this.searchLine = new SearchLine(this.treeList);

		this.treeContainer = new Container();
		this.treeContainer.addChild(this.treeList);

		this.labelInputContainer = new Container();

		const rule = () => new DynamicBorder((text) => theme.fg("borderMuted", text));
		this.addChild(new Spacer(1));
		this.addChild(rule());
		this.addChild(new Text(theme.bold(theme.fg("text", "Session tree")), 1, 0));
		this.addChild(this.searchLine);
		this.addChild(new Spacer(1));
		this.addChild(this.treeContainer);
		this.addChild(this.labelInputContainer);
		this.addChild(new Spacer(1));
		this.addChild(new TreeHelp());
		this.addChild(rule());

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	/** A stored row shows at most the start of a long label. Open the input with all of it, as a loaded session does. */
	private editLabel(entryId: string, currentLabel: string | undefined): void {
		const archive = this.archive;
		if (!archive?.labelIsSnippet(entryId)) {
			this.showLabelInput(entryId, currentLabel);
			return;
		}
		const load = new AbortController();
		this.labelLoad = load;
		this.treeContainer.clear();
		this.labelInputContainer.clear();
		this.labelInputContainer.addChild(new Text(theme.fg("dim", "Loading label…"), 2, 0));
		const settle = () => {
			if (load.signal.aborted || !archive.open) return false;
			this.labelLoad = undefined;
			return true;
		};
		archive.fullLabel(entryId, load.signal).then(
			(label) => {
				if (!settle()) return;
				this.showLabelInput(entryId, label);
				this.onLabelUpdate?.();
			},
			(error: Error) => {
				if (!settle()) return;
				this.hideLabelInput();
				this.onLabelError?.(error);
				this.onLabelUpdate?.();
			},
		);
	}

	private showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.labelInput = new LabelInput(entryId, currentLabel);
		this.labelInput.onSubmit = (id, label) => {
			void this.saveLabel(id, label).catch((error: Error) => this.onLabelError?.(error));
		};
		this.labelInput.onCancel = () => this.hideLabelInput();

		// Propagate current focused state
		this.focused = this._focused;

		this.treeContainer.clear();
		this.labelInputContainer.clear();
		this.labelInputContainer.addChild(this.labelInput);
	}

	private async saveLabel(entryId: string, label: string | undefined): Promise<void> {
		if (this.labelPending) return;
		this.labelPending = true;
		try {
			await this.onLabelChangeCallback?.(entryId, label);
			this.treeList.updateNodeLabel(entryId, label);
			this.hideLabelInput();
		} finally {
			this.labelPending = false;
			this.onLabelUpdate?.();
		}
	}

	private hideLabelInput(): void {
		this.labelInput = null;
		this.focused = this._focused;
		this.labelInputContainer.clear();
		this.treeContainer.clear();
		this.treeContainer.addChild(this.treeList);
	}

	get capturesViewportInput(): boolean {
		return this.labelInput === null;
	}

	handleInput(keyData: string): boolean {
		if (this.labelPending) return true;
		if (this.labelLoad) {
			if (getKeybindings().matches(keyData, "tui.select.cancel")) {
				this.labelLoad.abort();
				this.labelLoad = undefined;
				this.hideLabelInput();
			}
			return true;
		}
		if (this.labelInput) {
			this.labelInput.handleInput(keyData);
			return true;
		}
		return this.treeList.handleInput(keyData);
	}

	getTreeList(): TreeList {
		return this.treeList;
	}
}
