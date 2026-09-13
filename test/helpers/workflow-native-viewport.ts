import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import type { ReactiveWidgetComponent } from "../../packages/coding-agent/src/core/extensions/reactive-widget.js";
import { ScrollWidget } from "../../packages/coding-agent/src/modes/interactive/components/scroll-widget.js";

/** Drive native allocation while returning the source rows without scrollbar decoration. */
export function nativeWorkflowViewport(component: ReactiveWidgetComponent, height: () => number) {
	const widget = new ScrollWidget(
		{
			...component,
			render: (width) => component.render(width),
			invalidate: () => component.invalidate?.(),
			getScrollRequest: () => component.getScrollRequest?.(),
			onScroll: (state) => component.onScroll?.(state),
		},
		10,
	);
	return {
		render(width: number): string[] {
			const frame = renderLayoutFrame(widget, width, height(), () => {});
			return (frame.root.scrollContentLines ?? []).slice(widget.scrollTop, widget.scrollTop + widget.viewportHeight);
		},
	};
}
