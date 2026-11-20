import { isProxy } from "node:util/types";
import type { Component } from "@bastani/atomic-tui";

/** A renderer opts in with an own data field. A getter or opaque proxy isn't a promise that its state can be lost. */
export function declaresHistoryReplayable(component: Component | undefined): boolean {
	return (
		!!component &&
		!isProxy(component) &&
		Object.getOwnPropertyDescriptor(component, "historyReplayable")?.value === true
	);
}

const factoryProducts = new WeakSet<Component>();
/** The fact that a host supplied a component is provenance. Don't infer it from how the widget looks. */
export function fromChatComponentFactory<T extends Component>(component: T): T {
	if (component && (typeof component === "object" || typeof component === "function")) factoryProducts.add(component);
	return component;
}
export function isChatFactoryProduct(component: Component): boolean {
	return factoryProducts.has(component);
}
type DisposableRenderer = Component & { dispose?: () => void };

export function disposeRenderer(component: Component | undefined): void {
	try {
		(component as DisposableRenderer | undefined)?.dispose?.();
	} catch {}
}

export function runRendererCleanup(cleanup: (() => void) | undefined): void {
	try {
		cleanup?.();
	} catch {}
}
