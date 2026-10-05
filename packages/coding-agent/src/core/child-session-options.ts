import { resolve } from "node:path";
import type { CreateAgentSessionOptions } from "./sdk-types.ts";
import { createToolNameMatcher, isMcpToolName } from "./tool-selection.ts";

/** Internal owner-bound adapter seam. Does not admit work or transfer parent authority. */
export type ChildSessionOptionsResolver = (options: CreateAgentSessionOptions) => CreateAgentSessionOptions;

/** Optional undefined values retain inheritance; null and other explicit values do not. */
function definedOptions<T extends object>(options: T | undefined): Partial<T> {
	return Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function inheritChildSessionOptions(
	parent: CreateAgentSessionOptions,
	child: CreateAgentSessionOptions,
	availableToolNames: readonly string[] = [],
): CreateAgentSessionOptions {
	const builtins = { ...parent.builtins, ...definedOptions(child.builtins) };
	for (const name of ["workflows", "subagents", "mcp", "web-access", "intercom"] as const) {
		if (parent.builtins?.[name] === false) builtins[name] = false;
	}
	const ceiling = parent.noTools === "all" ? [] : parent.tools;
	const parentAllows = createToolNameMatcher(ceiling ?? []);
	const childAllows = child.tools === undefined ? undefined : createToolNameMatcher(child.tools);
	const tools =
		ceiling === undefined
			? child.tools
			: [...new Set([...availableToolNames, ...ceiling, ...(child.tools ?? [])])].filter(
					(name) =>
						!name.includes("*") &&
						parentAllows(name) &&
						(!childAllows || childAllows(name)) &&
						(!isMcpToolName(name) || ceiling.includes(name)),
				);
	const parentGate = parent.isFallbackModelAllowed;
	const childGate = child.isFallbackModelAllowed;
	return {
		...parent,
		...definedOptions(child),
		cwd: resolve(parent.cwd!, child.cwd ?? child.sessionManager?.getCwd() ?? "."),
		builtins,
		tools,
		excludedTools: [...(parent.excludedTools ?? []), ...(child.excludedTools ?? [])],
		noTools: parent.noTools === "all" ? "all" : (child.noTools ?? parent.noTools),
		extensionBindings: { ...parent.extensionBindings, ...definedOptions(child.extensionBindings) },
		isFallbackModelAllowed:
			parentGate && childGate
				? (model, effort) => parentGate(model, effort) && childGate(model, effort)
				: (parentGate ?? childGate),
	};
}
