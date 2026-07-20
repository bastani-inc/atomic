import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { runCallback, runSynchronousCallback } from "../callback-activity.ts";

declare module "@earendil-works/pi-agent-core" {
	interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> {
		/** Optional per-tool character cap for model-visible result persistence. Use Infinity to opt out. */
		maxResultSizeChars?: number;
	}
}

type PiToolParams<TParams extends TSchema> = Parameters<AgentTool<TParams>["execute"]>[1];
type PiPreparedParams<TParams extends TSchema> = ReturnType<NonNullable<AgentTool<TParams>["prepareArguments"]>>;

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TParams extends TSchema, TDetails = unknown>(
	definition: ToolDefinition<TParams, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<TParams, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		maxResultSizeChars: definition.maxResultSizeChars,
		prepareArguments: definition.prepareArguments
			? (args) =>
					runSynchronousCallback(
						{ kind: "tool.prepare", name: definition.name },
						() => definition.prepareArguments?.(args) as PiPreparedParams<TParams>,
					)
			: undefined,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			runCallback(
				{ kind: "tool.execute", name: definition.name, toolCallId },
				() => definition.execute(toolCallId, params as Static<TParams>, signal, onUpdate, ctxFactory?.() as ExtensionContext),
			),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<TSchema, unknown>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<TSchema, unknown>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool<TParams extends TSchema = TSchema, TDetails = unknown>(
	tool: AgentTool<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		maxResultSizeChars: tool.maxResultSizeChars,
		prepareArguments: tool.prepareArguments
			? (args) => tool.prepareArguments?.(args) as Static<TParams>
			: undefined,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params as PiToolParams<TParams>, signal, onUpdate),
	};
}
