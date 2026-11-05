/**
 * The idle-agent benchmark's invariants hold on the real `AgentSession` runtime (#4309): after every agent has run its
 * turns and waits on a long tool, no session is live or retained, handles do not grow with the agent count, and no
 * abort listener is held per agent.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
	ABORT_LISTENERS_PER_RUN_MAX,
	assertIdleInvariants,
	runIdleAgentBenchmark,
} from "../../scripts/perf/waiting-stages/benchmark.js";

const AGENTS = 150;
const TURNS = 2;
/**
 * Structural cost: 150 stages run real `AgentSession`s against the SQLite session store and journal, the benchmark
 * collects the heap between phases, and it idles for two seconds to sample event-loop delay.
 */
const REAL_BENCHMARK_TIMEOUT_MS = 120_000;

test(
	"idle agents hold no live or retained session and no per-agent handle or listener on the real runtime (#4309)",
	async () => {
		const report = await runIdleAgentBenchmark({
			agents: AGENTS,
			turns: TURNS,
			wave: AGENTS,
			store: "sqlite",
			label: "invariants",
			expectRelease: true,
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
