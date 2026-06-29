import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { installCopilotGeminiReasoningInterceptor } from "./copilot-gemini-reasoning.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 700_000;

/** Connect-phase timeout so a black-holed/firewalled host fails fast instead of hanging until the OS TCP timeout. */
export const HTTP_CONNECT_TIMEOUT_MS = 10_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "10 min", timeoutMs: 600_000 },
	{ label: "~12 min", timeoutMs: 700_000 },
	{ label: "30 min", timeoutMs: 1_800_000 },
	{ label: "Disabled", timeoutMs: 0 },
] as const;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

/**
 * Configure the global undici dispatcher used by fetch and SDK HTTP clients.
 *
 * Keep HTTP/2 disabled for now because some Node/undici combinations have
 * produced stream-reset crashes, and use a configurable idle timeout so stale
 * connections are eventually reclaimed while long-running requests remain
 * supported.
 */
export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}

	setGlobalDispatcher(
		new EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			headersTimeout: normalizedTimeoutMs,
			connect: { timeout: HTTP_CONNECT_TIMEOUT_MS },
		}),
	);

	// Bridge CAPI Gemini thought signatures (`reasoning_opaque`) on the inbound
	// SSE stream so multi-turn Copilot Gemini tool use does not stall on empty
	// completions. Idempotent and scoped to `*.githubcopilot.com` event streams.
	installCopilotGeminiReasoningInterceptor();
}
