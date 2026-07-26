import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.js";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";

interface ExtendedCallbacks extends OAuthLoginCallbacks {
	onInfo?(message: string, links: readonly { label: string; url: string }[]): void;
	onManualCodeInput?(): Promise<string>;
}

const models = [{
	id: "corp-model",
	name: "Corp Model",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4_096,
	maxTokens: 1_024,
}];

export default function customOAuthExtension(api: ExtensionAPI): void {
	api.registerProvider("corp-oauth", {
		api: "openai-completions",
		baseUrl: "https://corp.invalid/v1",
		models,
		refreshModels: async () => {
			const log = process.env.ATOMIC_CUSTOM_OAUTH_LOG;
			if (log) appendFileSync(log, `refresh:${process.pid}\n`);
			return models;
		},
		oauth: {
			name: "Corp OAuth",
			loginLabel: "Sign in to Corp",
			usesCallbackServer: true,
			login: async (baseCallbacks) => {
				const callbacks = baseCallbacks as ExtendedCallbacks;
				const log = process.env.ATOMIC_CUSTOM_OAUTH_LOG;
				if (log) appendFileSync(log, `engine:${process.pid}\n`);
				callbacks.onAuth({ url: "https://corp.invalid/login", instructions: "Open Corp" });
				callbacks.onDeviceCode({ userCode: "CORP-CODE", verificationUri: "https://corp.invalid/device" });
				callbacks.onProgress?.("waiting");
				callbacks.onInfo?.("corp-info", [{ label: "Corp docs", url: "https://corp.invalid/docs" }]);
				const tenant = await callbacks.onPrompt({ message: "Tenant", placeholder: "acme" });
				const account = await callbacks.onSelect({ message: "Account", options: [{ id: "primary", label: "Primary" }] });
				const manual = await callbacks.onManualCodeInput?.();
				return {
					access: `engine-token-${tenant}-${account}-${manual}`,
					refresh: "engine-refresh",
					expires: Date.now() + 60_000,
				};
			},
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		},
	});
}
