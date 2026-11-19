import type { AgentSessionServices } from "../../src/index.ts";

// A settled SDK session need not report which resources may load during a pending decision (#5693).
export const settled: AgentSessionServices["projectTrust"] = {
	pending: false,
	decisions: new Map(),
	extensionSourceDecisions: new Map(),
	abandon() {},
};
