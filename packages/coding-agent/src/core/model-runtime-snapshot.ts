import type { Api, AuthCheck, CredentialInfo, Model } from "@earendil-works/pi-ai";
import type { AuthStatus } from "./provider-composer.ts";

export interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	storedCredentialTypes: ReadonlyMap<string, CredentialInfo["type"]>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export function createEmptyModelRuntimeSnapshot(): ModelRuntimeSnapshot {
	return {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		storedCredentialTypes: new Map(),
		auth: new Map(),
	};
}

export function createModelRuntimeSnapshot(
	all: readonly Model<Api>[],
	available: readonly Model<Api>[],
	checks: readonly (readonly [string, AuthCheck | undefined])[],
	credentials: readonly CredentialInfo[],
): ModelRuntimeSnapshot {
	const auth = new Map(checks);
	const configuredProviders = new Set(
		checks
			.filter((entry): entry is readonly [string, AuthCheck] => entry[1] !== undefined)
			.map(([providerId]) => providerId),
	);
	return {
		all,
		available,
		configuredProviders,
		storedProviders: new Set(credentials.map((entry) => entry.providerId)),
		storedCredentialTypes: new Map(credentials.map((entry) => [entry.providerId, entry.type])),
		auth,
	};
}

export function updateSnapshotModels(snapshot: ModelRuntimeSnapshot, all: readonly Model<Api>[]): ModelRuntimeSnapshot {
	return {
		...snapshot,
		all,
		available: all.filter((model) => snapshot.configuredProviders.has(model.provider)),
	};
}

export function addRuntimeApiKeyProvider(snapshot: ModelRuntimeSnapshot, providerId: string): ModelRuntimeSnapshot {
	const configuredProviders = new Set(snapshot.configuredProviders).add(providerId);
	return {
		...snapshot,
		auth: new Map(snapshot.auth).set(providerId, { type: "api_key", source: "runtime API key" }),
		configuredProviders,
		storedProviders: new Set(snapshot.storedProviders).add(providerId),
		available: snapshot.all.filter((model) => configuredProviders.has(model.provider)),
	};
}

export function addStoredCredentialProvider(
	snapshot: ModelRuntimeSnapshot,
	providerId: string,
	type: CredentialInfo["type"],
): ModelRuntimeSnapshot {
	const configuredProviders = new Set(snapshot.configuredProviders).add(providerId);
	return {
		...snapshot,
		auth: new Map(snapshot.auth).set(providerId, {
			type,
			source: type === "oauth" ? "OAuth" : "Stored API key",
		}),
		configuredProviders,
		storedProviders: new Set(snapshot.storedProviders).add(providerId),
		storedCredentialTypes: new Map(snapshot.storedCredentialTypes).set(providerId, type),
		available: snapshot.all.filter((model) => configuredProviders.has(model.provider)),
	};
}

export function replaceStoredCredentialProviders(
	snapshot: ModelRuntimeSnapshot,
	credentials: readonly CredentialInfo[],
): ModelRuntimeSnapshot {
	const auth = new Map(snapshot.auth);
	const configuredProviders = new Set(snapshot.configuredProviders);
	for (const providerId of snapshot.storedProviders) {
		auth.delete(providerId);
		configuredProviders.delete(providerId);
	}
	for (const credential of credentials) {
		auth.set(credential.providerId, {
			type: credential.type,
			source: credential.type === "oauth" ? "OAuth" : "Stored API key",
		});
		configuredProviders.add(credential.providerId);
	}
	return {
		...snapshot,
		auth,
		configuredProviders,
		storedProviders: new Set(credentials.map((entry) => entry.providerId)),
		storedCredentialTypes: new Map(credentials.map((entry) => [entry.providerId, entry.type])),
		available: snapshot.all.filter((model) => configuredProviders.has(model.provider)),
	};
}

export function removeStoredCredentialProvider(
	snapshot: ModelRuntimeSnapshot,
	providerId: string,
	remainingAuth?: AuthCheck,
): ModelRuntimeSnapshot {
	const auth = new Map(snapshot.auth);
	const configuredProviders = new Set(snapshot.configuredProviders);
	const storedProviders = new Set(snapshot.storedProviders);
	const storedCredentialTypes = new Map(snapshot.storedCredentialTypes);
	auth.delete(providerId);
	configuredProviders.delete(providerId);
	storedProviders.delete(providerId);
	storedCredentialTypes.delete(providerId);
	if (remainingAuth) {
		auth.set(providerId, remainingAuth);
		configuredProviders.add(providerId);
	}
	return {
		...snapshot,
		auth,
		configuredProviders,
		storedProviders,
		storedCredentialTypes,
		available: snapshot.all.filter((model) => configuredProviders.has(model.provider)),
	};
}

export function getSnapshotProviderAuthStatus(
	snapshot: ModelRuntimeSnapshot,
	providerId: string,
	hasRuntimeApiKey: boolean,
	configured: AuthStatus | undefined,
): AuthStatus {
	if (hasRuntimeApiKey) return { configured: true, source: "runtime" };
	if (snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
	if (configured) return configured;
	const check = snapshot.auth.get(providerId);
	return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
}
