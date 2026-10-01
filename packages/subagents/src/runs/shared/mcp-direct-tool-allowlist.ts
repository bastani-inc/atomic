import { matchesMcpDirectToolSelection } from "@bastani/atomic";

export interface LiveMcpTool {
	readonly name: string;
	readonly server: string;
	readonly tool: string;
}

export function resolveMcpDirectToolNames(
	mcpDirectTools: readonly string[] | undefined,
	liveTools: readonly LiveMcpTool[],
): string[] {
	if (!mcpDirectTools?.length) return [];
	return [
		...new Set(
			liveTools
				.filter(({ server, tool }) => matchesMcpDirectToolSelection(mcpDirectTools, server, tool))
				.map(({ name }) => name),
		),
	];
}
