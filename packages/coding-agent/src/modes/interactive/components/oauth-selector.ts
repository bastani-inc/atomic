import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	getSelectPageIndex,
	Input,
	Spacer,
	TruncatedText,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.js";
import { isPreferredProvider } from "../../../core/preferred-providers.ts";
import type { AuthStatus } from "../../../core/provider-composer.ts";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.ts";
import { getProviderBrandStyle, type ProviderBrandStyle, startBrandAnimation } from "./provider-brand.ts";

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

/**
 * Component that renders an auth provider selector. With `tui`, the selected row of a preferred partner provider
 * shows its animated brand style.
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	readonly capturesViewportInput: boolean = true;
	private searchInput: Input;

	// Focusable implementation - propagate to search input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private modelRuntime: ModelRuntime;
	private getAuthStatus: (providerId: string) => AuthStatus;
	private onSelectCallback: (providerId: string, authType: AuthSelectorProvider["authType"]) => void;
	private onCancelCallback: () => void;
	private readonly animationStart = performance.now();
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
		super();

		this.mode = mode;
		this.modelRuntime = modelRuntime;
		this.getAuthStatus = getAuthStatus ?? ((providerId) => this.modelRuntime.getProviderAuthStatus(providerId));
		this.allProviders = providers;
		this.filteredProviders = providers;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		const title = mode === "login" ? "Select provider to configure:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.setValue(initialSearchInput);
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Initial render
		this.filterProviders(initialSearchInput);

		if (tui) this.stopAnimation = startBrandAnimation(tui, () => this.getSelectedBrandStyle() !== undefined);
	}

	override render(width: number): string[] {
		// The list is built from styled text, so an animated row needs a rebuild for each frame.
		if (this.stopAnimation && this.getSelectedBrandStyle()) this.updateList();
		return super.render(width);
	}

	/** Stops the brand animation. */
	dispose(): void {
		this.stopAnimation?.();
		this.stopAnimation = undefined;
	}

	private getSelectedBrandStyle(): ProviderBrandStyle | undefined {
		const selectedProvider = this.filteredProviders[this.selectedIndex];
		return selectedProvider && getProviderBrandStyle(selectedProvider.id);
	}

	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(this.allProviders, query, (provider) => `${provider.name} ${provider.id} ${provider.authType}`)
			: this.allProviders;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filteredProviders.length - MAX_VISIBLE),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			const statusIndicator = this.formatStatusIndicator(provider);
			const hasMultipleMethods = this.allProviders.some(
				(other) => other.id === provider.id && other.authType !== provider.authType,
			);
			const methodLabel = formatAuthSelectorProviderType(provider.authType, provider.subscription);
			const methodSuffix = hasMultipleMethods ? ` · ${methodLabel}` : "";
			// U+2726 is single-width in every terminal, unlike star emoji or ambiguous-width symbols such as U+2605.
			const partnerMarker = isPreferredProvider(provider.id) ? theme.fg("muted", " ✦") : "";
			const color = isSelected ? "accent" : "text";
			const brandStyle = isSelected && this.stopAnimation ? getProviderBrandStyle(provider.id) : undefined;
			const name = brandStyle
				? brandStyle(provider.name, performance.now() - this.animationStart)
				: theme.fg(color, provider.name);
			const text = name + partnerMarker + (methodSuffix && theme.fg(color, methodSuffix));
			const line = isSelected ? theme.fg("accent", "→ ") + text + statusIndicator : `  ${text}${statusIndicator}`;

			this.listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		// Show "no providers" if empty
		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "login"
						? "No providers available"
						: "No providers logged in. Use /login first."
					: "No matching providers";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 1, 0));
		}
	}

	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		const status = this.getAuthStatus(provider.id);
		if (!status.configured) return theme.fg("muted", " • not configured");
		switch (status.source) {
			case "environment":
				return theme.fg("success", ` ✓ env: ${status.label ?? "API key"}`);
			case "runtime":
				return theme.fg("success", " ✓ runtime API key");
			case "stored": {
				const storedType = this.modelRuntime.getStoredCredentialType(provider.id);
				return theme.fg(
					"success",
					` ✓ ${formatAuthSelectorProviderType(storedType ?? "api_key", provider.subscription)} configured`,
				);
			}
			case "fallback":
				return theme.fg("success", " ✓ configured");
			case "models_json_key":
				return theme.fg("success", " ✓ key in models.json");
			case "models_json_command":
				return theme.fg("success", " ✓ command in models.json");
			default:
				return theme.fg("muted", " • not configured");
		}
	}

	handleInput(keyData: string): boolean {
		const kb = getKeybindings();
		const pageIndex = getSelectPageIndex(kb, keyData, this.selectedIndex, this.filteredProviders.length, MAX_VISIBLE);
		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredProviders.length === 0) return true;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredProviders.length === 0) return true;
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		}
		// Page up/down
		else if (pageIndex !== undefined) {
			if (this.filteredProviders.length === 0) return true;
			this.selectedIndex = pageIndex;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
		return true;
	}
}
