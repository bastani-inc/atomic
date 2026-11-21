import type { ExtensionContext } from "@bastani/atomic";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import type { Component } from "@bastani/atomic-tui";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import type { renderSubagentResult } from "../../packages/subagents/src/tui/render.js";

export type { AgentToolResult, Component, Details, ExtensionContext };

export type RenderTheme = Parameters<typeof renderSubagentResult>[2];

export const theme = {
	fg: (_name: string, value: string) => value,
	bg: (_name: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as RenderTheme;

export function withMockedNow<T>(now: number, run: () => T): T {
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		return run();
	} finally {
		Date.now = originalNow;
	}
}

export function runningSingleResult(): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: "running" }],
		details: {
			mode: "single",
			results: [
				{
					agent: "worker",
					task: "do work",
					status: "continued",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
					progress: {
						agent: "worker",
						index: 0,
						status: "running",
						task: "do work",
						durationMs: 2_000,
						toolCount: 1,
						tokens: 10,
						recentTools: [],
						recentOutput: [],
					},
				},
			],
		},
	};
}
