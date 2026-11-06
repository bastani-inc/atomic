/** Shared by the idle-agent benchmark's integration files: each runs one scenario of `runIdleAgentBenchmark`. */

/**
 * Agents each scenario runs. 150 took 65–120 s of the 120 s budget on loaded CI shards, so the scenarios run 75, which
 * still catch a cost per agent: every run holds more agents than the 16 abort listeners it may hold, and the agents
 * outnumber the 16 handles each run may add. Each file asserts this for its own wave size.
 */
export const BENCHMARK_AGENTS = 75;
export const BENCHMARK_TURNS = 2;
