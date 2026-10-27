/**
 * Ambient provider credential and endpoint variables, each named where the
 * product reads it. Any of them makes a provider "available" or redirects its
 * traffic, so a developer's shell (or a CI secret) would otherwise change
 * which models a test sees: `auto` routing, for example, picks from every
 * available model, and `COPILOT_GITHUB_TOKEN` alone makes the whole
 * `github-copilot` catalog available.
 *
 * `test/unit/provider-credential-env-coverage.test.ts` fails when a provider
 * API key name appears in the product without being listed here.
 */
export const PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
	// packages/ai/src/env-api-keys.ts: apiKeyEnvMap.
	"AI_GATEWAY_API_KEY",
	"ANT_LING_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"BASETEN_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"META_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MOONSHOT_API_KEY",
	"MORPH_API_KEY",
	"NVIDIA_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"RADIUS_API_KEY",
	"TOGETHER_API_KEY",
	"TYPESAFE_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	// packages/ai/src/env-api-keys.ts: Anthropic tokens and workload identity federation.
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_WORKSPACE_ID",
	// packages/ai/src/env-api-keys.ts and providers/github-copilot-env.ts: Copilot token and endpoint.
	"COPILOT_GITHUB_TOKEN",
	"COPILOT_API_TARGET",
	"GITHUB_COPILOT_BASE_URL",
	"GITHUB_SERVER_URL",
	// packages/ai/src/env-api-keys.ts and api/bedrock-converse-stream.ts: Amazon Bedrock credentials, region and auth switches.
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_BEDROCK_FORCE_CACHE",
	"AWS_BEDROCK_FORCE_HTTP1",
	// packages/ai/src/env-api-keys.ts: Google Vertex application default credentials.
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	// packages/ai/src/api/azure-openai-config.ts: Azure OpenAI endpoint.
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AZURE_OPENAI_RESOURCE_NAME",
	// packages/ai/src/providers/cloudflare-stream.ts: Cloudflare endpoint placeholders.
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	// packages/ai/src/auth/oauth: Kimi OAuth hosts and the OAuth callback host.
	"KIMI_CODE_OAUTH_HOST",
	"KIMI_OAUTH_HOST",
	"PI_OAUTH_CALLBACK_HOST",
	// packages/coding-agent/src/extensions/llama: llama.cpp server and its Hugging Face token.
	"LLAMA_BASE_URL",
	"LLAMA_API_KEY",
	"HF_TOKEN_PATH",
	"HF_HOME",
	// packages/web-access (exa.ts, perplexity.ts): search provider keys.
	"EXA_API_KEY",
	"PERPLEXITY_API_KEY",
];

/** Live provider suites opt back in to the developer's ambient credentials with this variable set to `1`. */
export const KEEP_PROVIDER_CREDENTIALS_ENV = "ATOMIC_TEST_KEEP_PROVIDER_CREDENTIALS";

/** Remove every ambient provider credential and endpoint variable from `env`, unless the run opted to keep them. */
export function stripProviderCredentials(env: NodeJS.ProcessEnv = process.env): void {
	if (env[KEEP_PROVIDER_CREDENTIALS_ENV] === "1") return;
	for (const name of PROVIDER_CREDENTIAL_ENV_VARS) delete env[name];
}
