import type { Component } from "@bastani/atomic-tui";

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
