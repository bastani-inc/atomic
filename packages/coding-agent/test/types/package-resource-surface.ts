import type { ResolvedPaths } from "../../src/index.ts";

// A custom package manager only supplies supported resources, not the host's read-only migration catalog.
export const emptyResources: ResolvedPaths = { extensions: [], skills: [], prompts: [], themes: [], mcpServers: [] };
