/**
 * The idle-agent benchmark's invariants hold on the real `AgentSession` runtime (#4309): after every agent has run its
 * turns and waits on a long tool, no session is live or retained, handles do not grow with the agent count, and no
 * abort listener is held per agent. The evicted-waves scenario (#4373) is its own file,
 * waiting-stage-benchmark-eviction.test.ts, so the sharder can place the two apart.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
	ABORT_LISTENERS_PER_RUN_MAX,
	assertIdleInvariants,
	IDLE_RESOURCE_GROWTH_PER_RUN,
	runIdleAgentBenchmark,
} from "../../scripts/perf/waiting-stages/benchmark.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { BENCHMARK_AGENTS as AGENTS, BENCHMARK_TURNS as TURNS } from "../helpers/waiting-stage-benchmark.js";

useTemporaryAgentDir();

/**
 * Structural cost: every agent is a stage running a real `AgentSession` against the SQLite session store and journal,
 * the benchmark collects the heap between phases, and it idles for two seconds to sample event-loop delay.
 */
const REAL_BENCHMARK_TIMEOUT_MS = 120_000;

test(
	"idle agents hold no live or retained session and no per-agent handle or listener on the real runtime (#4309)",
	async () => {
		assert.ok(
			AGENTS > ABORT_LISTENERS_PER_RUN_MAX && AGENTS > IDLE_RESOURCE_GROWTH_PER_RUN,
			"a listener or handle per agent still exceeds what the one run may hold",
		);
		const report = await runIdleAgentBenchmark({
			agents: AGENTS,
			turns: TURNS,
			wave: AGENTS,
			store: "sqlite",
			label: "invariants",
			expectRelease: true,
			evict: false,
		});

		assert.equal(report.idle.liveSessions, 0);
		assert.equal(report.idle.sessionsRetained, 0);
		assert.equal(report.idle.waitingStages, AGENTS);
		assert.equal(report.idle.ciCallsPending, AGENTS);
		assert.ok(
			report.idle.abortListenersPerRun.max <= ABORT_LISTENERS_PER_RUN_MAX,
			`${report.idle.abortListenersPerRun.max} abort listeners on one run`,
		);
		assertIdleInvariants(report);
	},
	REAL_BENCHMARK_TIMEOUT_MS,
);
