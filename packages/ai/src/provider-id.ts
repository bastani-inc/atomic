export function normalizeProviderId(providerId: string): string {
	return providerId.toLowerCase() === "azure-openai-responses" ? "azure" : providerId;
}
