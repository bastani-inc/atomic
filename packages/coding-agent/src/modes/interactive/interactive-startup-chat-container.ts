import type { ScrollView, TuiMouseEvent } from "@bastani/atomic-tui";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { disposeRemoteRenderers } from "../interactive-engine/remote-renderer.ts";
import { type ContainerMouseResult, handleTranscriptBlockClick } from "./components/transcript-block-clicks.ts";
import { type Component, Container } from "./interactive-mode-deps.ts";

/**
 * Holds startup chat output off-screen until the resource disclosure slot has
 * been filled. Terminal scrollback cannot reorder lines that were painted
 * before an earlier container received content.
 */
export class StartupChatContainer extends Container {
	private startupOutputReleased = false;
	private counted: { children: Component[]; length: number; count: number } | undefined;
	private readonly isCounted: (child: Component) => boolean;
	private readonly transcriptView: () => ScrollView | undefined;

	constructor(
		isCounted: (child: Component) => boolean = () => false,
		transcriptView: () => ScrollView | undefined = () => undefined,
	) {
		super();
		this.isCounted = isCounted;
		this.transcriptView = transcriptView;
	}

	/** A click on the header of a tool block, grouped-call summary or agent card expands or collapses it. */
	override handleMouse(event: TuiMouseEvent): ContainerMouseResult {
		if (event.type === "click") {
			const handled = handleTranscriptBlockClick(
				this,
				this.children,
				(width, row) => this.childAtRow(width, row),
				event,
				(expanded) => {
					// The reader opened the block to read it: hold the view instead of following the end past its header.
					const view = this.transcriptView();
					if (expanded && view?.isFollowingEnd) view.scrollTo(view.scrollTop, { disableFollow: true });
				},
			);
			if (handled) return handled;
		}
		return super.handleMouse(event);
	}

	countedChildren(): number {
		const counted = this.counted;
		if (counted?.children === this.children && counted.length === this.children.length) return counted.count;
		let count = 0;
		for (const child of this.children) if (this.isCounted(child)) count += 1;
		this.counted = { children: this.children, length: this.children.length, count };
		return count;
	}

	override addChild(component: Component): void {
		const counted = this.current();
		super.addChild(component);
		if (counted) this.recount(counted, this.isCounted(component) ? 1 : 0);
	}

	override removeChild(component: Component): void {
		const index = this.children.lastIndexOf(component);
		if (index === -1) return;
		const counted = this.current();
		this.children.splice(index, 1);
		if (counted) this.recount(counted, this.isCounted(component) ? -1 : 0);
	}

	private current(): { children: Component[]; length: number; count: number } | undefined {
		const counted = this.counted;
		if (counted?.children === this.children && counted.length === this.children.length) return counted;
		this.counted = undefined;
		return undefined;
	}

	private recount(counted: { count: number }, change: number): void {
		this.counted = { children: this.children, length: this.children.length, count: counted.count + change };
	}

	releaseStartupOutput(): void {
		this.startupOutputReleased = true;
		this.invalidate();
	}

	override render(width: number): string[] {
		return this.startupOutputReleased ? super.render(width) : [];
	}

	/** A cleared transcript is rebuilt from new rows; the engine-rendered rows it drops are disposed. */
	override clear(): void {
		disposeRemoteRenderers(this.children);
		super.clear();
		this.counted = { children: this.children, length: 0, count: 0 };
	}
}

interface StartupChatOutputHost {
	chatContainer: Container;
	ui: { requestRender(): void };
}

export function releaseStartupChatOutput(host: StartupChatOutputHost): void {
	if (host.chatContainer instanceof StartupChatContainer) {
		host.chatContainer.releaseStartupOutput();
		markLifecycleTiming("chat-output-release");
		host.ui.requestRender();
	}
}
