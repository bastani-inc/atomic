import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { LegacyOAuthProvider, OAuthProviderDescriptor } from "./oauth-provider-bridge.ts";

export * from "@earendil-works/pi-ai/oauth";
export {
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviders,
	registerOAuthProvider,
	resetOAuthProviders,
} from "./oauth-provider-bridge.ts";

declare module "@earendil-works/pi-ai/oauth" {
	export function getOAuthApiKey(
		providerId: string,
		credentials: Record<string, OAuthCredentials>,
	): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null>;
	export function getOAuthProvider(providerId: string): OAuthProviderDescriptor | undefined;
	export function getOAuthProviders(): OAuthProviderDescriptor[];
	export function registerOAuthProvider(provider: LegacyOAuthProvider & { id: string }): void;
	export function resetOAuthProviders(): void;
}
