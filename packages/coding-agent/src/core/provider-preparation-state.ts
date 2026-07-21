import type { AuthStorage } from "./auth-storage.js";
import type { ProviderConfigInput } from "./model-registry-types.js";

export class RequiredProviderPreparationState {
	readonly #preparedVersions = new Map<string, string>();
	readonly #authenticated = new Set<string>();

	observeHostOAuth(provider: string): void {
		this.#authenticated.add(provider);
	}

	wasAuthenticated(provider: string): boolean {
		return this.#authenticated.has(provider);
	}

	invalidate(provider: string): void {
		this.#preparedVersions.delete(provider);
	}

	needed(
		required: Array<[string, ProviderConfigInput]>,
		providerGenerations: ReadonlyMap<string, number>,
		authStorage: AuthStorage,
		explicit: boolean,
	): Array<[string, ProviderConfigInput]> {
		return required.filter(([provider, config]) => {
			if (!explicit && config.requiresHostOAuth &&
				authStorage.getCredentialSnapshot(provider).credential === undefined &&
				!this.wasAuthenticated(provider)) return false;
			return this.#preparedVersions.get(provider) !== this.version(provider, config, providerGenerations, authStorage);
		});
	}

	mark(provider: string, config: ProviderConfigInput, providerGenerations: ReadonlyMap<string, number>, authStorage: AuthStorage): void {
		this.#preparedVersions.set(provider, this.version(provider, config, providerGenerations, authStorage));
	}

	private version(provider: string, config: ProviderConfigInput, providerGenerations: ReadonlyMap<string, number>, authStorage: AuthStorage): string {
		const runtimeGeneration = config.requiresHostOAuth ? 0 : authStorage.getRuntimeApiKeyGeneration(provider);
		return `${providerGenerations.get(provider) ?? 0}:${authStorage.getCredentialSnapshot(provider).generation}:${runtimeGeneration}`;
	}
}
