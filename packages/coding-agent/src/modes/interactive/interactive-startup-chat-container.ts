import { type ScrollView, type TuiMouseEvent, WindowedContainer } from "@bastani/atomic-tui";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { disposeRemoteRenderers } from "../interactive-engine/remote-renderer.ts";
import { type ContainerMouseResult, handleTranscriptBlockClick } from "./components/transcript-block-clicks.ts";
import type { Component, Container } from "./interactive-mode-deps.ts";

/**
 * Holds startup chat output off-screen until the resource disclosure slot has
 * been filled. Terminal scrollback cannot reorder lines that were painted
 * before an earlier container received content.
 */
export class StartupChatContainer extends WindowedContainer {
	private startupOutputReleased = false;
	private holdScrollback = false;
	private abandonPaint?: () => void;
	/** Renderers have already run. Only committing ordered terminal history waits for this optional read. */
	awaitChatRecords<T>(
		page: Promise<T | undefined>,
		paint: (data?: T) => void,
		scrollback: boolean,
		timeoutMs: number,
	): void {
		this.abandonPaint?.();
		this.holdScrollback = scrollback;
		const receiver: { done?: (data?: T) => void } = {};
		const finish = (data?: T) => {
			delete receiver.done;
			this.abandonPaint = undefined;
			this.holdScrollback = false;
			clearTimeout(timer);
			paint(data);
		};
		const timer = setTimeout(finish, timeoutMs);
		receiver.done = finish;
		this.abandonPaint = () => finish();
		settlePaint(page, receiver);
	}
	cancelChatRecordPaint(): void {
		this.abandonPaint?.();
		this.onVisibleChild = undefined;
	}
	private renderedWidth?: number;
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

	/**
	 * A click anywhere on a block Ctrl+O expands, such as a tool call, a grouped-call summary or a message card, expands
	 * or collapses it once the click cannot become a double-click.
	 */
	override handleMouse(event: TuiMouseEvent): ContainerMouseResult {
		if (event.type === "press" || event.type === "click") {
			const handled = handleTranscriptBlockClick(
				this,
				this,
				event,
				() => this.windowLayoutWidth ?? this.renderedWidth,
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

	insertChildren(index: number, components: readonly Component[]): void {
		const counted = this.current();
		this.children.splice(index, 0, ...components);
		if (counted) {
			let change = 0;
			for (const component of components) if (this.isCounted(component)) change += 1;
			this.recount(counted, change);
		}
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
		this.renderedWidth = width;
		if (!this.startupOutputReleased || this.holdScrollback) return [];
		// render() requests the entire scrollback; a row window instead observes just the children it returned.
		if (this.onVisibleChild) for (const child of this.children) this.onVisibleChild(child);
		return super.render(width);
	}

	protected override windowChildren(): readonly Component[] {
		return this.startupOutputReleased ? this.children : [];
	}

	/** A cleared transcript is rebuilt from new rows; the engine-rendered rows it drops are disposed. */
	override clear(): void {
		this.cancelChatRecordPaint();
		disposeRemoteRenderers(this.children);
		super.clear();
		this.counted = { children: this.children, length: 0, count: 0 };
	}
}

// A never-answering third-party read retains only its empty receiver after the deadline, not the view or its rows.
function settlePaint<T>(page: Promise<T | undefined>, receiver: { done?: (data?: T) => void }): void {
	void page.then(
		(data) => receiver.done?.(data),
		() => receiver.done?.(),
	);
}

interface ChatHistoryBuild {
	readonly built: Promise<void>;
	readonly finish: () => void;
}

const chatHistoryBuilds = new WeakMap<Container, ChatHistoryBuild>();

export function trackChatHistoryBuild(chat: Container, finish: () => void): { done(): void } {
	let settle = (): void => {};
	const build: ChatHistoryBuild = { built: new Promise<void>((resolve) => (settle = resolve)), finish };
	chatHistoryBuilds.set(chat, build);
	return {
		done() {
			if (chatHistoryBuilds.get(chat) === build) chatHistoryBuilds.delete(chat);
			settle();
		},
	};
}

export function chatHistoryBuilt(chat: Container | undefined): Promise<void> {
	return (chat && chatHistoryBuilds.get(chat)?.built) ?? Promise.resolve();
}

export function finishChatHistory(chat: Container | undefined): void {
	if (chat) chatHistoryBuilds.get(chat)?.finish();
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
