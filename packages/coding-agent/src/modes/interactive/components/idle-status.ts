import type { Component, Container } from "@earendil-works/pi-tui";

/** Width-filling placeholder that lets clear-on-shrink erase a former multi-line loader. */
export class IdleStatus implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		const blank = " ".repeat(width);
		return [blank, blank];
	}
}

export function mountIdleStatus(container: Container, clearOnShrink: boolean): void {
	if (clearOnShrink) container.addChild(new IdleStatus());
}
