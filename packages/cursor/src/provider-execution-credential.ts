import { deriveCursorCredentialScope } from "./catalog-cache.js";
import { waitForCursorExecutionCatalog } from "./provider-waits.js";

export type CursorAccessTokenResolver = () => Promise<string | undefined> | string | undefined;

export type CursorCredentialSelection =
	| { readonly state: "selected"; readonly epoch: number; readonly credentialScope: string }
	| { readonly state: "missing" | "rejected"; readonly epoch: number }
	| { readonly state: "superseded" | "disposed" };

export interface CursorExecutionCredentialDependencies {
	readonly currentEpoch: () => number;
	readonly inactive: () => boolean;
	readonly currentResolver: () => CursorAccessTokenResolver | undefined;
	readonly authenticatedCredentialScope: () => string | undefined;
	readonly scheduleDiscovery: (accessToken: string) => Promise<boolean> | undefined;
	readonly activeCredentialScope: () => string | undefined;
	readonly invalidateCredential: (message: string) => void;
	readonly activationSignal: AbortSignal;
}

const LOOKUP_FAILED = "Cursor credential lookup failed. Log in again and reselect an exact model with --list-models.";
const NOT_AUTHENTICATED = "Cursor is not authenticated. Log in again and reselect an exact model with --list-models.";

export async function activateCursorExecutionCredential(
	accessToken: string,
	credentialScope: string,
	callerSignal: AbortSignal | undefined,
	dependencies: CursorExecutionCredentialDependencies,
): Promise<boolean> {
	while (!dependencies.inactive()) {
		const epoch = dependencies.currentEpoch();
		const first = await resolveCursorCredentialSelection(epoch, dependencies);
		if (first.state === "superseded") continue;
		const firstScope = applyCurrentSelection(first, epoch, dependencies);
		if (firstScope === undefined || firstScope !== credentialScope) return false;
		if (!isCurrent(epoch, dependencies)) continue;

		const task = dependencies.scheduleDiscovery(accessToken);
		const waitSignal = callerSignal
			? AbortSignal.any([callerSignal, dependencies.activationSignal])
			: dependencies.activationSignal;
		if (task && !await waitForCursorExecutionCatalog(task, waitSignal)) return false;
		if (!isCurrent(epoch, dependencies)) continue;

		const second = await resolveCursorCredentialSelection(epoch, dependencies);
		if (second.state === "superseded") continue;
		const secondScope = applyCurrentSelection(second, epoch, dependencies);
		return secondScope === credentialScope
			&& isCurrent(epoch, dependencies)
			&& dependencies.activeCredentialScope() === credentialScope;
	}
	return false;
}

async function resolveCursorCredentialSelection(
	epoch: number,
	dependencies: CursorExecutionCredentialDependencies,
): Promise<CursorCredentialSelection> {
	if (dependencies.inactive()) return { state: "disposed" };
	if (epoch !== dependencies.currentEpoch()) return { state: "superseded" };
	const resolver = dependencies.currentResolver();
	if (!resolver) {
		const credentialScope = dependencies.authenticatedCredentialScope();
		return credentialScope ? { state: "selected", epoch, credentialScope } : { state: "missing", epoch };
	}
	let accessToken: string | undefined;
	try {
		accessToken = await resolver();
	} catch {
		if (dependencies.inactive()) return { state: "disposed" };
		if (epoch !== dependencies.currentEpoch()) return { state: "superseded" };
		return { state: "rejected", epoch };
	}
	if (dependencies.inactive()) return { state: "disposed" };
	if (epoch !== dependencies.currentEpoch()) return { state: "superseded" };
	const credentialScope = accessToken ? deriveCursorCredentialScope(accessToken) : undefined;
	return credentialScope ? { state: "selected", epoch, credentialScope } : { state: "missing", epoch };
}

function applyCurrentSelection(
	selection: CursorCredentialSelection,
	epoch: number,
	dependencies: CursorExecutionCredentialDependencies,
): string | undefined {
	if (selection.state === "superseded" || selection.state === "disposed" || !isCurrent(epoch, dependencies)) return undefined;
	if (selection.state === "selected") return selection.credentialScope;
	if (selection.state === "missing" && !dependencies.currentResolver() && !dependencies.authenticatedCredentialScope()) return undefined;
	dependencies.invalidateCredential(selection.state === "rejected" ? LOOKUP_FAILED : NOT_AUTHENTICATED);
	return undefined;
}

function isCurrent(epoch: number, dependencies: CursorExecutionCredentialDependencies): boolean {
	return !dependencies.inactive() && epoch === dependencies.currentEpoch();
}
