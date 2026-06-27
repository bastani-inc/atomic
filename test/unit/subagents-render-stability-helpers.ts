import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@bastani/atomic";
import type { AsyncJobState, Details } from "../../packages/subagents/src/shared/types.js";
import { PULSE_FRAMES, renderSubagentResult, RUNNING_FRAMES } from "../../packages/subagents/src/tui/render.js";

export type { AgentToolResult, AsyncJobState, Component, Details, ExtensionContext };

export type RenderTheme = Parameters<typeof renderSubagentResult>[2];

export const theme = {
    fg: (_name: string, value: string) => value,
    bg: (_name: string, value: string) => value,
    bold: (value: string) => value,
} as unknown as RenderTheme;

export { PULSE_FRAMES, RUNNING_FRAMES };
const SPINNER_CHARS = new Set(RUNNING_FRAMES);

export function withMockedNow<T>(now: number, run: () => T): T {
    const originalNow = Date.now;
    Date.now = () => now;
    try {
        return run();
    } finally {
        Date.now = originalNow;
    }
}

export function stripSpinnerChars(line: string): string {
    return [...line].filter((char) => !SPINNER_CHARS.has(char)).join("");
}

export function firstSpinnerChar(text: string): string | undefined {
    for (const char of text) if (SPINNER_CHARS.has(char)) return char;
    return undefined;
}

const PULSE_CHARS = new Set(PULSE_FRAMES);

export function firstPulseChar(text: string): string | undefined {
    for (const char of text) if (PULSE_CHARS.has(char)) return char;
    return undefined;
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
                    exitCode: 0,
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
