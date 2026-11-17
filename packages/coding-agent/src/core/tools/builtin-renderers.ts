import type { ToolRenderers } from "../extensions/types.ts";

const builtinCalls = new WeakSet<NonNullable<ToolRenderers["renderCall"]>>();
const builtinResults = new WeakSet<NonNullable<ToolRenderers["renderResult"]>>();

export function markBuiltinToolRenderers<T extends ToolRenderers>(definition: T): T {
	if (definition.renderCall) builtinCalls.add(definition.renderCall);
	if (definition.renderResult) builtinResults.add(definition.renderResult);
	return definition;
}

export function isBuiltinToolCallRenderer(renderer: ToolRenderers["renderCall"]): boolean {
	return renderer !== undefined && builtinCalls.has(renderer);
}

export function isBuiltinToolResultRenderer(renderer: ToolRenderers["renderResult"]): boolean {
	return renderer !== undefined && builtinResults.has(renderer);
}
