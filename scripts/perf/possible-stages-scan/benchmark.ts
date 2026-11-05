#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Options {
	readonly revisions: readonly { readonly label: string; readonly revision: string }[];
	readonly rounds: number;
	readonly warmup: number;
	readonly out?: string;
}

interface ScanResult {
	readonly stages: readonly string[];
	readonly warnings: readonly string[];
	readonly uncertainties?: readonly unknown[];
}

interface Variant {
	readonly label: string;
	readonly revision: string;
	readonly scan: (entry: string) => ScanResult;
}

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCANNER_FILES = ["src/shared/possible-stages.ts", "src/workflows/identity.ts"];

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const revisions = (value("revisions") ?? "base=origin/main,current=HEAD").split(",").map((pair) => {
		const [label, revision] = pair.split("=");
		if (label === undefined || revision === undefined)
			throw new Error(`--revisions expects label=revision, got ${pair}`);
		return { label, revision };
	});
	const out = value("out");
	return {
		revisions,
		rounds: Number(value("rounds") ?? 15),
		warmup: Number(value("warmup") ?? 3),
		...(out === undefined ? {} : { out }),
	};
}

function scanEntries(): string[] {
	const builtin = join(REPO_ROOT, "packages/workflows/builtin");
	const definitions = readdirSync(builtin)
		.filter((file) => file.endsWith(".d.ts") && file !== "index.d.ts")
		.map((file) => join(builtin, file.replace(/\.d\.ts$/, ".ts")));
	const fixtures = join(REPO_ROOT, "test/fixtures/possible-stage-prediction");
	return [
		...definitions.sort(),
		...readdirSync(fixtures)
			.sort()
			.map((name) => join(fixtures, name, "workflow.mjs")),
	];
}

async function loadVariant(label: string, revision: string, directory: string): Promise<Variant> {
	const root = join(directory, label);
	for (const file of SCANNER_FILES) {
		const target = join(root, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(
			target,
			execFileSync("git", ["show", `${revision}:packages/workflows/${file}`], { cwd: REPO_ROOT }),
		);
	}
	symlinkSync(join(REPO_ROOT, "packages/workflows/builtin"), join(root, "builtin"));
	const module = (await import(pathToFileURL(join(root, SCANNER_FILES[0]!)).href)) as {
		scanPossibleStagesFromSource: (entry: string) => ScanResult;
	};
	return { label, revision, scan: module.scanPossibleStagesFromSource };
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sameScanOutput(variants: readonly Variant[], entries: readonly string[]): readonly string[] {
	const differences: string[] = [];
	for (const entry of entries) {
		const [first, ...rest] = variants.map((variant) => variant.scan(entry));
		for (const [index, other] of rest.entries()) {
			const same =
				JSON.stringify([first!.stages, first!.warnings]) === JSON.stringify([other.stages, other.warnings]);
			if (!same) differences.push(`${variants[index + 1]!.label}: ${entry}`);
		}
	}
	return differences;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const entries = scanEntries();
	const directory = mkdtempSync(join(tmpdir(), "possible-stages-scan-"));
	try {
		const variants: Variant[] = [];
		for (const { label, revision } of options.revisions) variants.push(await loadVariant(label, revision, directory));
		const differences = sameScanOutput(variants, entries);
		const uncertain = variants.map(
			(variant) => entries.filter((entry) => (variant.scan(entry).uncertainties?.length ?? 0) > 0).length,
		);
		const samples = new Map<string, number[]>(variants.map((variant) => [variant.label, []]));
		for (let round = 0; round < options.warmup + options.rounds; round += 1) {
			const order = variants.map((_, index) => variants[(index + round) % variants.length]!);
			for (const variant of order) {
				const started = performance.now();
				for (const entry of entries) variant.scan(entry);
				const elapsed = performance.now() - started;
				if (round >= options.warmup) samples.get(variant.label)!.push(elapsed);
			}
		}
		console.log(
			`${entries.length} definitions, ${options.rounds} rounds after ${options.warmup} warm-up, variants interleaved`,
		);
		console.log(
			`stages and warnings identical across variants: ${differences.length === 0 ? "yes" : differences.join("; ")}`,
		);
		console.log("");
		console.log(
			"| variant | revision | definitions with uncertainties | median ms/round | min | max | median ms/definition |",
		);
		console.log("|---|---|---:|---:|---:|---:|---:|");
		variants.forEach((variant, index) => {
			const values = samples.get(variant.label)!;
			const middle = median(values);
			console.log(
				`| ${variant.label} | ${variant.revision} | ${uncertain[index]} | ${middle.toFixed(1)} | ${Math.min(...values).toFixed(1)} | ${Math.max(...values).toFixed(1)} | ${(middle / entries.length).toFixed(3)} |`,
			);
		});
		if (options.out !== undefined) {
			writeFileSync(
				options.out,
				JSON.stringify({ entries, differences, samples: Object.fromEntries(samples) }, null, "\t"),
			);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

await main();
