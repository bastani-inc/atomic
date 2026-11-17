import { WindowedContainer } from "@bastani/atomic-tui";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { disposeRemoteRenderers } from "../interactive-engine/remote-renderer.ts";
import type { Component, Container } from "./interactive-mode-deps.ts";

/**
 * Holds startup chat output off-screen until the resource disclosure slot has
 * been filled. Terminal scrollback cannot reorder lines that were painted
 * before an earlier container received content.
 */
export class StartupChatContainer extends WindowedContainer {
	private startupOutputReleased = false;
	private counted: { children: Component[]; length: number; count: number } | undefined;
	private readonly isCounted: (child: Component) => boolean;

	constructor(isCounted: (child: Component) => boolean = () => false) {
		super();
		this.isCounted = isCounted;
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

	/** Inserts `components` at `index`, keeping the count of the counted ones current. */
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
		return this.startupOutputReleased ? super.render(width) : [];
	}

	protected override windowChildren(): readonly Component[] {
		return this.startupOutputReleased ? this.children : [];
	}

	/** A cleared transcript is rebuilt from new rows; the engine-rendered rows it drops are disposed. */
	override clear(): void {
		disposeRemoteRenderers(this.children);
		super.clear();
		this.counted = { children: this.children, length: 0, count: 0 };
	}
}

interface ChatHistoryBuild {
	readonly built: Promise<void>;
	readonly finish: () => void;
}

/** The history being built into each chat behind the end of a long session, until it is built or the chat cleared. */
const chatHistoryBuilds = new WeakMap<Container, ChatHistoryBuild>();

/**
 * Tracks the history being built into `chat`; `finish` builds the rest at once. Call `done` once it is built, or the
 * chat no longer shows it.
 */
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

/** Settles once the history being built into `chat`, if any, is built. */
export function chatHistoryBuilt(chat: Container | undefined): Promise<void> {
	return (chat && chatHistoryBuilds.get(chat)?.built) ?? Promise.resolve();
}

/** Builds the rest of the history being built into `chat`, if any, at once. */
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
