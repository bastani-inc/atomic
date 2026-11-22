import { type Api, getApiProvider, type Model } from "@bastani/atomic-ai/compat";

const API_PROVIDER_PREWARM = Symbol.for("@bastani/atomic-ai/api-prewarm");

type PrewarmableApiProvider = {
	[API_PROVIDER_PREWARM]?: () => Promise<void>;
};

/** What `prewarmModelApi` asks of the session's model runtime about the transport a request uses. */
export interface ModelApiTransport {
	streamsThroughExtension?(model: Pick<Model<Api>, "provider" | "api">): boolean;
}

/**
 * Trigger loading of the selected model's lazy API implementation off the
 * first-prompt critical path. Safe no-op on providers without a prewarm hook
 * and never rejects. With the session's model runtime, loads nothing for a model
 * whose requests an extension streams itself: they never use that implementation.
 */
export function prewarmModelApi(
	model: Pick<Model<Api>, "provider" | "api"> | undefined,
	runtime?: ModelApiTransport,
): Promise<void> {
	if (!model?.api) return Promise.resolve();
	try {
		if (runtime?.streamsThroughExtension?.(model)) return Promise.resolve();
	} catch {
		return Promise.resolve();
	}
	const provider = getApiProvider(model.api) as PrewarmableApiProvider | undefined;
	const prewarm = provider?.[API_PROVIDER_PREWARM];
	if (typeof prewarm !== "function") return Promise.resolve();
	try {
		return Promise.resolve(prewarm()).catch(() => undefined);
	} catch {
		return Promise.resolve();
	}
}
