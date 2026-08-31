import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderRequestRecord, ProviderSocketAttempt } from "./collector.js";
import type { ScreenSnapshot } from "./screen.js";

export type BenchmarkLane = "release" | "node";
export type BenchmarkBuild = "baseline" | "candidate" | "candidate-bytecode";
export type CacheProfile = "warm" | "atomic-state-cold";
export type SampleState = "success" | "product-failure" | "invalid";

export interface BenchmarkMetrics {
	readonly startupCompleteMs: number;
	readonly dispatchMs: number;
	/** Contract metric: settled startup paint plus Enter-to-provider dispatch. */
	readonly spawnToDispatchMs: number;
	/** Diagnostic wall-clock mark that also includes nonce typing and echo wait. */
	readonly launchToProviderFirstByteMs: number;
}

export interface BenchmarkSample {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly lane: BenchmarkLane;
	readonly build: BenchmarkBuild;
	readonly profile: CacheProfile;
	readonly state: SampleState;
	readonly command: string;
	readonly startedAt: string;
	readonly marksNs: Readonly<Record<string, string>>;
	readonly metricsMs?: BenchmarkMetrics;
	readonly artifactHashes: Readonly<Record<string, string>>;
	readonly environmentHash?: string;
	readonly runtime?: Readonly<Record<string, string>>;
	readonly rawArtifactDirectory: string;
	readonly failures: readonly string[];
	readonly providerValidation?: {
		readonly nonceFound: boolean;
		readonly toolNames: readonly string[];
		readonly requestCount: number;
	};
	readonly workflowListSucceeded?: boolean;
}

export interface RawSampleArtifacts {
	readonly ptyOutput: string;
	readonly receivedChunks: readonly { readonly atNs: string; readonly data: string }[];
	readonly coherentSnapshot?: ScreenSnapshot;
	readonly completeSnapshot?: ScreenSnapshot;
	readonly providerAttempts: readonly ProviderSocketAttempt[];
	readonly providerRequests: readonly ProviderRequestRecord[];
}

export function elapsedMs(startNs: bigint, endNs: bigint): number {
	if (endNs < startNs) throw new Error("elapsed duration cannot be negative");
	return Number(endNs - startNs) / 1e6;
}

export async function persistSample(
	outputDirectory: string,
	sample: BenchmarkSample,
	artifacts: RawSampleArtifacts,
): Promise<void> {
	const rawDirectory = join(outputDirectory, sample.rawArtifactDirectory);
	await mkdir(rawDirectory, { recursive: true });
	await Promise.all([
		writeFile(join(rawDirectory, "pty-output.txt"), artifacts.ptyOutput, "utf8"),
		writeFile(
			join(rawDirectory, "pty-chunks.json"),
			`${JSON.stringify(artifacts.receivedChunks, null, 2)}\n`,
			"utf8",
		),
		writeFile(
			join(rawDirectory, "screens.json"),
			`${JSON.stringify({ coherent: artifacts.coherentSnapshot, complete: artifacts.completeSnapshot }, null, 2)}\n`,
			"utf8",
		),
		writeFile(
			join(rawDirectory, "provider-attempts.json"),
			`${JSON.stringify(artifacts.providerAttempts, null, 2)}\n`,
			"utf8",
		),
		writeFile(
			join(rawDirectory, "provider-requests.json"),
			`${JSON.stringify(artifacts.providerRequests, null, 2)}\n`,
			"utf8",
		),
		writeFile(join(rawDirectory, "sample.json"), `${JSON.stringify(sample, null, 2)}\n`, "utf8"),
	]);
	await appendFile(join(outputDirectory, "samples.jsonl"), `${JSON.stringify(sample)}\n`, "utf8");
}
