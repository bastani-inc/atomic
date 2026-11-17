/**
 * Credential screening for model chains (a pinned model and its `fallbackModels`) and routing lists.
 *
 * Whether a provider has usable credentials is known locally, from the same snapshot the model registry and
 * `workflow({ action: "models" })` read, so a candidate whose provider has none is skipped before any request, and a
 * provider that refused its credentials is not asked again in the same walk. Messages name models and providers only,
 * never a credential.
 */

import { getProviderLoginHelp } from "./auth-guidance.ts";

/** Why a candidate was skipped without a request: its provider has no credentials, or it refused them. */
export type SkippedModelReason = "no-credentials" | "auth-failed";

/** A chain or routing candidate skipped without a request. */
export interface SkippedModel {
	/** `provider/model`, as configured or resolved. */
	readonly model: string;
	readonly provider: string;
	readonly reason: SkippedModelReason;
}

/** The candidates whose provider has usable credentials, in their original order, and the ones skipped. */
export interface CredentialPartition<T> {
	readonly usable: T[];
	readonly skipped: { readonly candidate: T; readonly provider: string }[];
}

/**
 * Split `candidates` into those whose provider has usable credentials and those whose provider has none, keeping
 * each side in the original order. A candidate whose provider is unknown (`providerOf` returns `undefined`) is kept:
 * resolving it is the caller's business, and dropping it here would hide a typo behind a credentials message.
 * `hasCredentials` is called at most once per provider, so a chain that names one provider many times costs one check.
 */
export function partitionByCredentials<T>(
	candidates: readonly T[],
	providerOf: (candidate: T) => string | undefined,
	hasCredentials: (provider: string) => boolean,
): CredentialPartition<T> {
	const known = new Map<string, boolean>();
	const usable: T[] = [];
	const skipped: { candidate: T; provider: string }[] = [];
	for (const candidate of candidates) {
		const provider = providerOf(candidate);
		if (provider === undefined) {
			usable.push(candidate);
			continue;
		}
		let has = known.get(provider);
		if (has === undefined) {
			has = hasCredentials(provider);
			known.set(provider, has);
		}
		if (has) usable.push(candidate);
		else skipped.push({ candidate, provider });
	}
	return { usable, skipped };
}

/** The provider of a `provider/model[:level]` reference, or `undefined` for a bare id. */
export function providerOfModelReference(reference: string): string | undefined {
	const slash = reference.indexOf("/");
	return slash > 0 ? reference.slice(0, slash) : undefined;
}

function describeSkipped(skipped: SkippedModel): string {
	return skipped.reason === "auth-failed"
		? `${skipped.model} (${skipped.provider} rejected its credentials)`
		: `${skipped.model} (no credentials for ${skipped.provider})`;
}

/**
 * The message for a chain or routing list in which no model can run: each model and the provider it lacks. It starts
 * with "No API key found" for a missing credential so message-based failure classifiers keep reading it as an auth
 * failure.
 */
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

/** No candidate of a chain or routing list has usable credentials. Thrown before any request. */
export class NoUsableModelError extends Error {
	readonly code = "no_usable_model";
	readonly skipped: readonly SkippedModel[];

	constructor(skipped: readonly SkippedModel[]) {
		super(formatNoUsableModelMessage(skipped));
		this.name = "NoUsableModelError";
		this.skipped = Object.freeze(skipped.map((entry) => Object.freeze({ ...entry })));
	}
}
