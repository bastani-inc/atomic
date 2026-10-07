import { resolve } from "node:path";
import type { CreateAgentSessionOptions } from "./sdk-types.ts";
import { applyToolModifiers, getToolListError, isToolModifier } from "./settings-merge.js";
import { createToolNameMatcher, isMcpToolName } from "./tool-selection.ts";
import { allToolNames, getDefaultToolNames } from "./tools/index.js";

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
	const parentNamesMcp = createToolNameMatcher((ceiling ?? []).filter((entry) => entry.startsWith("mcp__")));
	const toolListError = child.tools ? getToolListError(child.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const codingToolNames = new Set<string>(allToolNames);
	const inheritedCustomToolNames = [...new Set([...availableToolNames, ...(ceiling ?? [])])].filter(
		(name) => !name.includes("*") && !codingToolNames.has(name) && parentAllows(name),
	);
	const childToolNames = child.tools?.some(isToolModifier)
		? applyToolModifiers(
				[
					...((child.noTools ?? parent.noTools)
						? []
						: ((child.settingsManager ?? parent.settingsManager)?.getDefaultTools() ?? getDefaultToolNames())),
					...inheritedCustomToolNames,
				],
				child.tools,
			)
		: child.tools;
	const childAllows = childToolNames === undefined ? undefined : createToolNameMatcher(childToolNames);
	const tools =
		ceiling === undefined
			? child.tools
			: [...new Set([...availableToolNames, ...ceiling, ...(childToolNames ?? [])])].filter(
					(name) =>
						!name.includes("*") &&
						parentAllows(name) &&
						(!childAllows || childAllows(name)) &&
						(!isMcpToolName(name) || ceiling.includes(name) || parentNamesMcp(name)),
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
