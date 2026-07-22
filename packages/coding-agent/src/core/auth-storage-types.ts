import type { OAuthCredentials } from "@earendil-works/pi-ai";

export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	/** Provider-scoped configuration persisted alongside the credential. */
	env?: Record<string, string>;
}

export type OAuthCredential = { type: "oauth" } & OAuthCredentials;
export type AuthCredential = ApiKeyCredential | OAuthCredential;
export type AuthStorageData = Record<string, AuthCredential>;

export interface AuthStatus {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
}
