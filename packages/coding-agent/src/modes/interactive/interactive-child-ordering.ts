import type { Component, Container } from "@earendil-works/pi-tui";

/**
 * Append rendered children normally, then move only newly appended components
 * before an already-attached anchor without detaching or recreating the anchor.
 */
export function appendNewChildrenBeforeAttachedChild(
	container: Container,
	anchor: Component | undefined,
	append: () => void,
): void {
	const anchorIndex = anchor ? container.children.indexOf(anchor) : -1;
	if (anchorIndex < 0) {
		append();
		return;
	}

	const existingChildren = new Set(container.children);
	append();
	if (!anchor || !container.children.includes(anchor)) return;

	const appendedChildren = container.children.filter((child) => !existingChildren.has(child));
	if (appendedChildren.length === 0) return;

	// Direct splices preserve live child instances; remove/add APIs would detach and remount them.
	const appendedSet = new Set(appendedChildren);
	for (let index = container.children.length - 1; index >= 0; index--) {
		if (appendedSet.has(container.children[index]!)) container.children.splice(index, 1);
	}
	container.children.splice(anchorIndex, 0, ...appendedChildren);
}
