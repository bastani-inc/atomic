const MODEL_UNAVAILABLE_FOR_INTEGRATOR_PATTERN = /model_not_available_for_integrator|not available for integrator/i;

function modelUnavailableGuidance(modelId: string): string {
	return `${modelId} isn't available to Atomic's GitHub Copilot integration; pick another model or run /login to refresh the model list.`;
}

/**
 * Lead a Copilot "model not available for integrator" rejection with what it means and what to do,
 * keeping the provider's raw error below it as the detail.
 */
export function formatCopilotProviderError(modelId: string, errorMessage: string): string {
	if (!MODEL_UNAVAILABLE_FOR_INTEGRATOR_PATTERN.test(errorMessage)) return errorMessage;
	const guidance = modelUnavailableGuidance(modelId);
	if (errorMessage.startsWith(guidance)) return errorMessage;
	return `${guidance}\n\n${errorMessage}`;
}
