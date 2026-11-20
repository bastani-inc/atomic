/** Display-only evidence from streaming a saved result. Ordinary (including extension-supplied) result fields cannot
 * impersonate a saved projection. `null` means the content could not be counted; show its archive note instead. */
const counts = new WeakMap<object, number | null>();
export function bindSavedReadLines(content: object, lines: number | null): void {
	counts.set(content, lines);
}
export function savedReadLines(content: object | undefined): number | null | undefined {
	return content && counts.get(content);
}
