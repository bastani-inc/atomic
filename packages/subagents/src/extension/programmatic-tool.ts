import type { ExtensionContext } from "@bastani/atomic";

import type { SubagentToolResult } from "../shared/types.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";

type ProgrammaticSubagentExecute = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((result: SubagentToolResult) => void) | undefined,
	ctx: ExtensionContext,
) => Promise<SubagentToolResult>;

/** Programmatic tool calls always use non-interactive execution. */
function normalizeProgrammaticSubagentParams(params: SubagentParamsLike): SubagentParamsLike {
	return { ...params, clarify: false };
}

export function createProgrammaticSubagentToolEntrypoint(execute: ProgrammaticSubagentExecute): {
	execute: ProgrammaticSubagentExecute;
} {
	return {
		execute(id, params, signal, onUpdate, ctx) {
			return execute(id, normalizeProgrammaticSubagentParams(params), signal, onUpdate, ctx);
		},
	};
}
