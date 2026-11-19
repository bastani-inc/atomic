import { type Component, WindowedContainer } from "@bastani/atomic-tui";
import { remoteHistoryRow } from "../../interactive-engine/remote-renderer.ts";
import { declaresHistoryReplayable, disposeRenderer, isChatFactoryProduct } from "./renderer-disposal.js";

/** A renderer may keep widget state that is not in the stored row. Only these exceptions (not stock rows or
 * their page) survive eviction, keyed by the saved occurrence and sub-block within this session. */
export class SavedRendererInstances {
	private readonly source = Symbol();
	private readonly kept = new Map<string, Component[]>();
	private readonly owner = new WeakMap<Component, string>();
	private readonly retired = new WeakSet<Component[]>();
	get(key: string): Component[] | undefined {
		const group = this.kept.get(key);
		if (group) this.retired.delete(group);
		return group;
	}
	private stateful(c: Component): boolean {
		const remote = remoteHistoryRow(c);
		if (remote) return !remote.historyReplayable;
		return isChatFactoryProduct(c)
			? !declaresHistoryReplayable(c)
			: c.selectionTextMayChangeOnReplay === true && c.historyReplayable !== true;
	}
	private needed(c: Component): boolean {
		return this.stateful(c) && !remoteHistoryRow(c)?.unrendered;
	}
	/** Register a widget already drawn in the live transcript, before compaction gives its occurrence to a saved page. */
	rememberLive(key: string, component: Component): boolean {
		if (!this.needed(component)) return false;
		if (this.owner.get(component) !== key) this.remember(key, [component]);
		return true;
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
		if (!components.some((c) => this.stateful(c))) return;
		this.kept.set(key, components);
		for (const component of components) {
			this.owner.set(component, key);
			const remote = remoteHistoryRow(component);
			if (remote) {
				const weak = new WeakRef(this);
				remote.onReplayabilityChange(() => weak.deref()?.settle(key));
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
	dispose(): void {
		for (const group of this.kept.values()) for (const c of group) disposeRenderer(c);
		this.kept.clear();
	}
}
