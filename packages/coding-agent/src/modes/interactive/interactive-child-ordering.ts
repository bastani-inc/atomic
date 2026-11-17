import type { Component, Container } from "@bastani/atomic-tui";

function hasIntactTail(children: Component[], anchorIndex: number, tailBefore: Component[]): boolean {
	if (children.length < anchorIndex + tailBefore.length) return false;
	for (let offset = 0; offset < tailBefore.length; offset++) {
		if (children[anchorIndex + offset] !== tailBefore[offset]) return false;
	}
	return true;
}

function rotateAppendedBeforeTail(
	children: Component[],
	anchorIndex: number,
	lengthBefore: number,
	tailBefore: Component[],
): void {
	const addedCount = children.length - lengthBefore;
	if (addedCount <= 0) return;
	const appendedChildren = children.slice(lengthBefore);
	for (let index = 0; index < addedCount; index++) {
		children[anchorIndex + index] = appendedChildren[index]!;
	}
	for (let offset = 0; offset < tailBefore.length; offset++) {
		children[anchorIndex + addedCount + offset] = tailBefore[offset]!;
	}
}

function reorderMutatedTailBeforeAnchor(
	children: Component[],
	anchor: Component,
	previousAnchorIndex: number,
	tailBefore: Component[],
): void {
	const currentAnchorIndex =
		children[previousAnchorIndex] === anchor ? previousAnchorIndex : children.lastIndexOf(anchor);
	if (currentAnchorIndex < 0) return;

	const tailSet = new Set(tailBefore);
	const appendedChildren: Component[] = [];
	const survivingTail: Component[] = [];
	for (let index = currentAnchorIndex; index < children.length; index++) {
		const child = children[index]!;
		if (tailSet.has(child)) survivingTail.push(child);
		else appendedChildren.push(child);
	}
	if (appendedChildren.length === 0) return;

	let writeIndex = currentAnchorIndex;
	for (const child of appendedChildren) children[writeIndex++] = child;
	for (const child of survivingTail) children[writeIndex++] = child;
}

export function appendNewChildrenBeforeAttachedChild(
	container: Container,
	anchor: Component | undefined,
	append: () => void,
): void {
	const childrenBefore = container.children;
	const anchorIndex = anchor ? childrenBefore.lastIndexOf(anchor) : -1;
	if (!anchor || anchorIndex < 0) {
		append();
		return;
	}

	const lengthBefore = childrenBefore.length;
	const tailBefore = childrenBefore.slice(anchorIndex, lengthBefore);
	append();

	const children = container.children;
	if (children === childrenBefore && hasIntactTail(children, anchorIndex, tailBefore)) {
		rotateAppendedBeforeTail(children, anchorIndex, lengthBefore, tailBefore);
		return;
	}
	reorderMutatedTailBeforeAnchor(children, anchor, anchorIndex, tailBefore);
}
