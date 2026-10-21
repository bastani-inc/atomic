import type { ClientAttribution, ClientIdentity } from "@bastani/pi-ai";
import { APP_NAME, VERSION } from "../config.js";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/** Who provider requests are attributed to: OpenRouter's app title and referer, NVIDIA's invoke origin, OpenCode's client. */
const ATOMIC_ATTRIBUTION: ClientAttribution = { name: APP_NAME, url: "https://atomic.sh", categories: ["cli-agent"] };

/**
 * How Atomic's requests identify it to providers: its own detailed `User-Agent`, and attribution to Atomic as a CLI
 * agent while install telemetry is enabled.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: { custom: getPiUserAgent(VERSION) },
		attribution: isInstallTelemetryEnabled(settingsManager) ? ATOMIC_ATTRIBUTION : null,
	};
}
