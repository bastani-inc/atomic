import type { TUI } from "@bastani/atomic-tui";
import type { ModelRuntime } from "../../../core/model-runtime.js";
import { isPreferredProvider } from "../../../core/preferred-providers.ts";
import type { AuthStatus } from "../../../core/provider-composer.ts";
import { theme } from "../theme/theme.js";
import { getProviderBrandStyle, startBrandAnimation } from "./provider-brand.ts";
import { FramedSelector, type SelectorItem, type SelectorTone } from "./selector.ts";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	subscription?: boolean;
};

export function formatAuthSelectorProviderType(
	authType: AuthSelectorProvider["authType"],
	subscription?: boolean,
): string {
	if (authType === "api_key") return "API key";
	return subscription === false ? "account" : "subscription";
}

const MAX_VISIBLE = 8;

/** The status shown right of a provider: how it is configured, or that it is not. */
function formatStatus(
	provider: AuthSelectorProvider,
	status: AuthStatus,
	modelRuntime: ModelRuntime,
): { text: string; tone: SelectorTone } {
	if (!status.configured) return { text: "not configured", tone: "muted" };
	switch (status.source) {
		case "environment":
			return { text: `✓ env: ${status.label ?? "API key"}`, tone: "success" };
		case "runtime":
			return { text: "✓ runtime API key", tone: "success" };
		case "stored": {
			const storedType = modelRuntime.getStoredCredentialType(provider.id);
			return {
				text: `✓ ${formatAuthSelectorProviderType(storedType ?? "api_key", provider.subscription)} configured`,
				tone: "success",
			};
		}
		case "fallback":
			return { text: "✓ configured", tone: "success" };
		case "models_json_key":
			return { text: "✓ key in models.json", tone: "success" };
		case "models_json_command":
			return { text: "✓ command in models.json", tone: "success" };
		default:
			return { text: "not configured", tone: "muted" };
	}
}

/**
 * The `/login` and `/logout` provider picker in the shared selector look: a search box, one row per provider and
 * sign-in method with its status on the right. With `tui`, the selected row of a preferred partner provider shows its
 * animated brand style.
 */
export class OAuthSelectorComponent extends FramedSelector<AuthSelectorProvider> {
	private stopAnimation: (() => void) | undefined;

	constructor(
		mode: "login" | "logout",
		modelRuntime: ModelRuntime,
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void,
		onCancel: () => void,
		getAuthStatus?: (providerId: string) => AuthStatus,
		initialSearchInput = "",
		tui?: TUI,
	) {
		const authStatus = getAuthStatus ?? ((providerId: string) => modelRuntime.getProviderAuthStatus(providerId));
		const animationStart = performance.now();
		const animation = { live: false };
		const items = providers.map((provider, index): SelectorItem<AuthSelectorProvider> => {
			const hasMultipleMethods = providers.some(
				(other) => other.id === provider.id && other.authType !== provider.authType,
			);
			const methodSuffix = hasMultipleMethods
				? ` · ${formatAuthSelectorProviderType(provider.authType, provider.subscription)}`
				: "";
			// U+2726 is single-width in every terminal, unlike star emoji or ambiguous-width symbols such as U+2605.
			const partnerMarker = isPreferredProvider(provider.id) ? " ✦" : "";
			const label = provider.name + partnerMarker + methodSuffix;
			const status = formatStatus(provider, authStatus(provider.id), modelRuntime);
			return {
				id: `${index}`,
				value: provider,
				label,
				tag: status.text,
				tagTone: status.tone,
				searchText: `${provider.id} ${provider.authType}`,
				labelStyle: (text, selected) => {
					const color = selected ? "accent" : "text";
					// A label cut short by a narrow terminal keeps one colour.
					if (text !== label) return theme.fg(color, text);
					const brandStyle = selected && animation.live ? getProviderBrandStyle(provider.id) : undefined;
					const name = brandStyle
						? brandStyle(provider.name, performance.now() - animationStart)
						: theme.fg(color, provider.name);
					return (
						name +
						(partnerMarker && theme.fg("muted", partnerMarker)) +
						(methodSuffix && theme.fg(color, methodSuffix))
					);
				},
			};
		});
		super({
			title: mode === "login" ? "Select provider to configure" : "Select provider to logout",
			search: true,
			initialQuery: initialSearchInput,
			items,
			maxVisible: MAX_VISIBLE,
			emptyText: mode === "login" ? "No providers available" : "No providers logged in. Use /login first.",
			onSelect: (item) => onSelect(item.value.id, item.value.authType),
			onCancel,
		});
		if (tui) {
			animation.live = true;
			this.stopAnimation = startBrandAnimation(tui, () => {
				const selected = this.selector.getSelected();
				return selected !== undefined && getProviderBrandStyle(selected.value.id) !== undefined;
			});
		}
	}

	/** Stops the brand animation. */
	dispose(): void {
		this.stopAnimation?.();
		this.stopAnimation = undefined;
	}
}
