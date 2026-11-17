import { getProviderLoginHelp } from "./auth-guidance.ts";

export type SkippedModelReason = "no-credentials" | "auth-failed";

export interface SkippedModel {
	readonly model: string;
	readonly provider: string;
	readonly reason: SkippedModelReason;
}

export interface SkippedCandidate<T> {
	readonly candidate: T;
	readonly provider: string;
}

export interface CredentialPartition<T> {
	readonly usable: T[];
	readonly skipped: SkippedCandidate<T>[];
}

export function partitionByCredentials<T>(
	candidates: readonly T[],
	providerOf: (candidate: T) => string | undefined,
	hasCredentials: (provider: string) => boolean,
): CredentialPartition<T> {
	const known = new Map<string, boolean>();
	const usable: T[] = [];
	const skipped: SkippedCandidate<T>[] = [];
	for (const candidate of candidates) {
		const provider = providerOf(candidate);
		if (provider === undefined) {
			usable.push(candidate);
			continue;
		}
		const cached = known.get(provider);
		const has = cached === undefined ? hasCredentials(provider) : cached;
		if (cached === undefined) known.set(provider, has);
		if (has) usable.push(candidate);
		else skipped.push({ candidate, provider });
	}
	return { usable, skipped };
}

export function providerOfModelReference(
	reference: string,
	knownProviders: readonly string[] = [],
): string | undefined {
	const trimmed = reference.trim();
	const normalized = trimmed.toLowerCase();
	let matched: string | undefined;
	for (const provider of knownProviders) {
		if (
			normalized.startsWith(`${provider.toLowerCase()}/`) &&
			(matched === undefined || provider.length > matched.length)
		)
			matched = provider;
	}
	if (matched !== undefined) return matched;
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(normalized)) return undefined;
	const slash = trimmed.indexOf("/");
	return slash > 0 ? trimmed.slice(0, slash) : undefined;
}

function describeSkipped(skipped: SkippedModel): string {
	return skipped.reason === "auth-failed"
		? `${skipped.model} (${skipped.provider} rejected its credentials)`
		: `${skipped.model} (no credentials for ${skipped.provider})`;
}

export function formatNoUsableModelMessage(skipped: readonly SkippedModel[]): string {
	const missing = skipped.filter((entry) => entry.reason === "no-credentials");
	const lead =
		skipped.length === 1 && missing.length === 1
			? `No API key found for ${missing[0]!.provider}: ${missing[0]!.model} cannot run without it, and no other model runs in its place.`
			: missing.length > 0
				? `No API key found for any model in the chain: ${skipped.map(describeSkipped).join(", ")}.`
				: `No model in the chain can run: ${skipped.map(describeSkipped).join(", ")}.`;
	return `${lead}\n\n${getProviderLoginHelp()}`;
}

export class NoUsableModelError extends Error {
	readonly code = "no_usable_model";
	readonly skipped: readonly SkippedModel[];

	constructor(skipped: readonly SkippedModel[]) {
		super(formatNoUsableModelMessage(skipped));
		this.name = "NoUsableModelError";
		this.skipped = Object.freeze(skipped.map((entry) => Object.freeze({ ...entry })));
	}
}
