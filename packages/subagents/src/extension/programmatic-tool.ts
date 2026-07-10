import type { ExtensionContext } from "@bastani/atomic";
import type { Static } from "typebox";

import type { SubagentToolResult } from "../shared/types.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { SubagentParams } from "./schemas.ts";

export type ProgrammaticSubagentParams = Static<typeof SubagentParams>;

type ProgrammaticSubagentExecute = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((result: SubagentToolResult) => void) | undefined,
	ctx: ExtensionContext,
) => Promise<SubagentToolResult>;

/** Remove the retired public field before schema validation of resumed/legacy calls. */
export function prepareProgrammaticSubagentArguments(args: unknown): ProgrammaticSubagentParams {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return args as ProgrammaticSubagentParams;
	}
	const { clarify: _legacyClarify, ...prepared } = args as Record<string, unknown>;
	return prepared as ProgrammaticSubagentParams;
}

/** Programmatic tool calls are non-interactive regardless of omitted or legacy input. */
export function normalizeProgrammaticSubagentParams(params: SubagentParamsLike): SubagentParamsLike {
	const { clarify: _legacyClarify, ...normalized } = params;
	return { ...normalized, clarify: false };
}

export function createProgrammaticSubagentToolEntrypoint(execute: ProgrammaticSubagentExecute): {
	prepareArguments: typeof prepareProgrammaticSubagentArguments;
	execute: ProgrammaticSubagentExecute;
} {
	return {
		prepareArguments: prepareProgrammaticSubagentArguments,
		execute(id, params, signal, onUpdate, ctx) {
			return execute(id, normalizeProgrammaticSubagentParams(params), signal, onUpdate, ctx);
		},
	};
}
