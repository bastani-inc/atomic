import type { MultiSelectViewProps } from "./components/multi-select-view.ts";
import type { OptionListViewProps } from "./components/option-list-view.ts";
import type { PreviewPane } from "./components/preview/preview-pane.ts";
import type { StatefulView } from "./stateful-view.ts";

export interface TabComponents {
	optionList: StatefulView<OptionListViewProps>;
	preview: PreviewPane;
	multiSelect?: StatefulView<MultiSelectViewProps>;
	/** Worst-case body height for this tab at `width`, across its options, read from cached layouts. */
	maxBodyHeight: (width: number) => number;
}
