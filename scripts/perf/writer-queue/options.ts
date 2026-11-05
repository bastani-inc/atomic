import { fileURLToPath } from "node:url";
import { WriterQueueBenchmarkConfigError } from "./errors.js";
import { parseFlags, parseNumber, parseNumberList, verifyBaseline, verifyOutputPath } from "./support.js";

export const repository = fileURLToPath(new URL("../../../", import.meta.url));
export const storagePath = "packages/coding-agent/src/core/storage";

export interface BenchmarkOptions<Scenario extends { readonly name: string }> {
	readonly scenarios: readonly Scenario[];
	readonly holds: readonly number[];
	readonly repeats: number;
	readonly warmupMs: number;
	readonly measureMs: number;
	readonly baseline: string;
	readonly runtime: "node" | "bun";
	readonly out?: string;
}

export function parseBenchmarkOptions<Scenario extends { readonly name: string }>(
	argv: readonly string[],
	available: readonly Scenario[],
): BenchmarkOptions<Scenario> {
	const flags = parseFlags(argv, ["scenarios", "holds", "repeats", "warmup", "measure", "baseline", "runtime", "out"]);
	const scenarios = (flags.get("scenarios") ?? available.map((scenario) => scenario.name).join(","))
		.split(",")
		.map((name) => {
			const scenario = available.find((candidate) => candidate.name === name);
			if (scenario === undefined)
				throw new WriterQueueBenchmarkConfigError(
					"--scenarios",
					"unknown-scenario",
					`Supported scenarios: ${available.map((candidate) => candidate.name).join(", ")}`,
				);
			return scenario;
		});
	const runtime = flags.get("runtime") ?? "node";
	if (runtime !== "node" && runtime !== "bun")
		throw new WriterQueueBenchmarkConfigError("--runtime", "unknown-runtime", "Pass --runtime node or --runtime bun");
	const holds = parseNumberList("--holds", flags.get("holds") ?? "25,50,100,200,400", {
		min: 0,
		unit: "milliseconds",
	});
	const repeats = parseNumber("--repeats", flags.get("repeats") ?? "3", {
		min: 1,
		integer: true,
		unit: "repetitions",
	});
	const warmupMs = parseNumber("--warmup", flags.get("warmup") ?? "1000", { min: 0, unit: "milliseconds" });
	const measureMs = parseNumber("--measure", flags.get("measure") ?? "8000", { min: 1, unit: "milliseconds" });
	const baseline = flags.get("baseline") ?? "77746f5";
	verifyBaseline("--baseline", baseline, storagePath, repository);
	const out = flags.get("out");
	return {
		scenarios,
		holds,
		repeats,
		warmupMs,
		measureMs,
		baseline,
		runtime,
		...(out === undefined ? {} : { out: verifyOutputPath("--out", out) }),
	};
}

export function parseDeadHeadOptions(argv: readonly string[]): {
	readonly gaps: readonly number[];
	readonly repeats: number;
	readonly baseline: string;
} {
	const flags = parseFlags(argv, ["gaps", "repeats", "baseline"]);
	const gaps = parseNumberList("--gaps", flags.get("gaps") ?? "100,1000,1500", { min: 0, unit: "milliseconds" });
	const repeats = parseNumber("--repeats", flags.get("repeats") ?? "5", {
		min: 1,
		integer: true,
		unit: "repetitions",
	});
	const baseline = flags.get("baseline") ?? "77746f5";
	verifyBaseline("--baseline", baseline, storagePath, repository);
	return { gaps, repeats, baseline };
}
