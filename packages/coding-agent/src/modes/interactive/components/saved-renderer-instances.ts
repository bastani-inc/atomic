import { type Component, type HistoryLeaf, WindowedContainer } from "@bastani/atomic-tui";
import {
	RemoteCustomMessageComponent,
	RemoteToolExecutionComponent,
} from "../../interactive-engine/remote-renderer.ts";
import { disposeRenderer } from "./renderer-disposal.js";

/** What drawing a saved page uses: an instance kept for a key, and the hook that marks and keeps a new one. */
export interface SavedRenderers {
	get(key: string): Component[] | undefined;
	remember(key: string, components: Component[], position?: { seq: number; block: number }): void;
}

/** A renderer may keep widget state that is not in the stored row. Only these exceptions (not stock rows or
 * their page) survive eviction, keyed by the saved occurrence and sub-block within this session. */
export class SavedRendererInstances implements SavedRenderers {
	/** The saved source that every saved row of this session is marked with. */
	readonly source = Symbol();
	private readonly kept = new Map<string, Component[]>();
	private readonly owner = new WeakMap<Component, string>();
	private readonly retired = new WeakSet<Component[]>();
	get(key: string): Component[] | undefined {
		const group = this.kept.get(key);
		if (group) this.retired.delete(group);
		return group;
	}
	private needed(c: Component): boolean {
		return (
			c.selectionTextMayChangeOnReplay === true &&
			c.historyReplayable !== true &&
			!((c instanceof RemoteToolExecutionComponent || c instanceof RemoteCustomMessageComponent) && c.unrendered)
		);
	}
	private settle(key: string): void {
		const group = this.kept.get(key);
		if (!group || !this.retired.has(group) || group.some((c) => this.needed(c))) return;
		this.kept.delete(key);
		for (const component of group) disposeRenderer(component);
	}
	remember(key: string, components: Component[], position?: { seq: number; block: number }): void {
		if (position)
			for (let part = 0; part < components.length; part++)
				WindowedContainer.markHistoryComponent(components[part]!, this.source, position.seq, position.block, part);
		if (!components.some((c) => c.selectionTextMayChangeOnReplay === true && c.historyReplayable !== true)) return;
		this.kept.set(key, components);
		for (const component of components) {
			this.owner.set(component, key);
			if (component instanceof RemoteToolExecutionComponent || component instanceof RemoteCustomMessageComponent) {
				const weak = new WeakRef(this);
				component.onReplayabilityChange(() => weak.deref()?.settle(key));
			}
		}
	}
	protect(component: Component): boolean {
		const key = this.owner.get(component);
		if (!key) return false;
		const group = this.kept.get(key);
		if (!group) return false;
		if (group.some((c) => this.needed(c))) {
			this.retired.add(group);
			return true;
		}
		this.kept.delete(key);
		return false;
	}
	/** Draw saved rows without keeping new instances: reuse a kept one, and only note where each new row belongs. */
	transient(positions: Map<Component, HistoryLeaf>): SavedRenderers & { owns(component: Component): boolean } {
		const reused = new Set<Component>();
		return {
			get: (key) => {
				const group = this.kept.get(key);
				const [seq, block] = key.split(":");
				for (let part = 0; group && part < group.length; part++) {
					reused.add(group[part]!);
					positions.set(group[part]!, {
						source: this.source,
						seq: Number(seq),
						block: block === "entry" ? 0 : Number(block),
						part,
					});
				}
				return group;
			},
			remember: (_key, components, position) => {
				if (!position) return;
				for (let part = 0; part < components.length; part++)
					positions.set(components[part]!, {
						source: this.source,
						seq: position.seq,
						block: position.block,
						part,
					});
			},
			owns: (component) => reused.has(component),
		};
	}
	dispose(): void {
		for (const group of this.kept.values()) for (const c of group) disposeRenderer(c);
		this.kept.clear();
	}
}
