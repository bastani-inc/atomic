/**
 * The idle-agent benchmark with evicted waves (#4373): once every agent of a wave waits on the long tool, its run is
 * evicted and each agent is only its index entry; the wake rebuilds each run by replay without asking the model again.
 * Split from waiting-stage-benchmark-invariants.test.ts, so the sharder can place the two apart.
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
import {
	BENCHMARK_AGENTS as AGENTS,
	REAL_BENCHMARK_TIMEOUT_MS,
	BENCHMARK_TURNS as TURNS,
} from "../helpers/waiting-stage-benchmark.js";

useTemporaryAgentDir();

/** Three runs of 25 agents: 25 exceed the 16 abort listeners a run may hold, and 75 the 48 handles three runs may add. */
const WAVES = 3;

test(
	"evicted waves leave every idle agent as its index entry, and the wake rebuilds them by replay without asking the model again (#4373)",
	async () => {
		assert.ok(
			AGENTS / WAVES > ABORT_LISTENERS_PER_RUN_MAX && AGENTS > IDLE_RESOURCE_GROWTH_PER_RUN * WAVES,
			"a listener or handle per agent still exceeds what the waves may hold",
		);
		const report = await runIdleAgentBenchmark({
			agents: AGENTS,
			turns: TURNS,
			wave: AGENTS / WAVES,
			store: "sqlite",
			label: "evicted",
			expectRelease: true,
			evict: true,
		});

		assert.equal(report.idle.residentEntries, AGENTS);
		assert.equal(report.idle.liveSessions, 0);
		assert.equal(report.idle.sessionsRetained, 0);
		assert.equal(report.idle.ciCallsPending, AGENTS);
		assertIdleInvariants(report);
		assert.equal(report.woken, AGENTS);
		assert.equal(report.fakeLongToolCalls, AGENTS, "no long call ran again");
		// Each agent's turns take two requests each, and its waiting turn one for the call and one for the answer.
		assert.equal(report.modelRequests, AGENTS * (2 * TURNS + 2), "no turn of any agent was asked again");
	},
	REAL_BENCHMARK_TIMEOUT_MS,
);
