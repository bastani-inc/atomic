import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@bastani/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	hyperlink,
	Input,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@earendil-works/pi-tui";
import { replaceControlCharacters } from "../../../utils/ansi.js";
import { copyToClipboard } from "../../../utils/clipboard.js";
import { openBrowser } from "../../../utils/open-browser.ts";
import { theme } from "../theme/theme.js";
import { AuthUrlComponent } from "./auth-url.js";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.js";

/**
 * The `http:` or `https:` URL `value` names, normalized, or undefined. The shared launcher also opens files and custom
 * protocols, so login only opens web URLs. Normalizing percent-encodes control characters, which would otherwise end a
 * terminal hyperlink early.
 */
function webUrl(value: string): string | undefined {
	if (!URL.canParse(value)) return undefined;
	const url = new URL(value);
	return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
}

/**
 * `value` normalized as a web URL, else with control characters replaced: an untrusted string printed as is could end a
 * hyperlink early or send its own escape sequences to the terminal.
 */
function displayUrl(value: string): string {
	return webUrl(value) ?? replaceControlCharacters(value);
}

/** `text` as a terminal hyperlink to `url` when that is a web URL, else plain `text`. */
function webLink(text: string, url: string): string {
	const target = webUrl(url);
	return target === undefined ? text : hyperlink(text, target);
}

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private authUrl?: AuthUrlComponent;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private authCancelHint?: Text;
	private deviceCodeAction?: { info: OAuthDeviceCodeInfo; hint: Container };
	private deviceCodeHint?: Container;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private declare onComplete: (success: boolean, message?: string) => void;

	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.onComplete = onComplete;
		this.tui = tui;

		const providerName = providerNameOverride || providerId;
		const title = titleOverride ?? `Login to ${providerName}`;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				const value = this.input.getValue();
				this.replaceInputWithSubmittedText(value);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private clearDeviceCodeAction(): void {
		if (this.deviceCodeHint) {
			this.contentContainer.removeChild(this.deviceCodeHint);
		}
		this.deviceCodeHint = undefined;
		this.deviceCodeAction = undefined;
	}

	private cancel(): void {
		this.clearDeviceCodeAction();
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(
		url: string,
		instructions?: string,
		options: { autoOpenBrowser?: boolean; showCancelHint?: boolean } = {},
	): void {
		this.clearDeviceCodeAction();
		this.contentContainer.clear();
		this.authCancelHint = undefined;
		this.contentContainer.addChild(new Spacer(1));
		const target = webUrl(url);
		this.authUrl = new AuthUrlComponent(this.tui, target ?? replaceControlCharacters(url));
		this.contentContainer.addChild(this.authUrl);

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		if (options.showCancelHint) {
			this.authCancelHint = new Text(`(${keyHint("tui.select.cancel", "Cancel")})`, 1, 0);
			this.contentContainer.addChild(this.authCancelHint);
		}

		if ((options.autoOpenBrowser ?? true) && target !== undefined) {
			openBrowser(target);
		}
		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		this.authUrl = undefined;
		info = {
			...info,
			openBrowserOnConfirm: info.openBrowserOnConfirm ?? true,
			copyCodeOnConfirm: info.copyCodeOnConfirm ?? true,
		};
		this.clearDeviceCodeAction();
		this.contentContainer.clear();
		this.authCancelHint = undefined;
		this.contentContainer.addChild(new Spacer(1));
		const shownUrl = displayUrl(info.verificationUri);
		this.contentContainer.addChild(new Text(theme.fg("accent", webLink(shownUrl, shownUrl)), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		this.contentContainer.addChild(new Text(theme.fg("dim", webLink(clickHint, info.verificationUri)), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${info.userCode}`), 1, 0));

		if (!this.signal.aborted && (info.openBrowserOnConfirm || info.copyCodeOnConfirm)) {
			const actionLabel = info.openBrowserOnConfirm
				? info.copyCodeOnConfirm
					? "to open browser and copy code"
					: "to open browser"
				: "to copy code";
			const hint = new Container();
			hint.addChild(new TruncatedText(`(${keyHint("tui.select.confirm", actionLabel)})`, 1, 0));
			this.contentContainer.addChild(hint);
			this.deviceCodeHint = hint;
			this.deviceCodeAction = { info, hint };
		}
		this.tui.requestRender();
	}

	private setDeviceCodeStatus(hint: Container, message: string): void {
		if (this.signal.aborted || !this.focused || !this.contentContainer.children.includes(hint)) return;
		hint.children = [new TruncatedText(theme.fg("dim", message), 1, 0)];
		this.tui.requestRender();
	}

	private activateDeviceCode(info: OAuthDeviceCodeInfo, hint: Container): void {
		this.setDeviceCodeStatus(hint, info.copyCodeOnConfirm ? "Copying code..." : "Browser open requested");
		if (info.copyCodeOnConfirm) {
			void copyToClipboard(info.userCode)
				.then(() => this.setDeviceCodeStatus(hint, "Code copied to clipboard"))
				.catch(() => this.setDeviceCodeStatus(hint, "Copy code manually"));
		}
		if (info.openBrowserOnConfirm) {
			try {
				const target = webUrl(info.verificationUri);
				if (target !== undefined) openBrowser(target);
			} catch {
				// Launcher failures must not interrupt login.
			}
		}
	}

	private replaceInputWithSubmittedText(value: string): void {
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			child === this.input ? new Text(`> ${value}`, 0, 0) : child,
		);
	}

	private removeAuthCancelHint(): void {
		if (!this.authCancelHint) return;
		this.contentContainer.children = this.contentContainer.children.filter((child) => child !== this.authCancelHint);
		this.authCancelHint = undefined;
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.clearDeviceCodeAction();
		this.removeAuthCancelHint();
		this.input.setValue("");
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "Cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/** Resolve and release a manual input prompt after an out-of-band callback succeeds. */
	dismissPendingInput(): void {
		this.inputResolver?.("");
		this.inputResolver = undefined;
		this.inputRejecter = undefined;
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.clearDeviceCodeAction();
		this.removeAuthCancelHint();
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(`(${keyHint("tui.select.cancel", "Cancel,")} ${keyHint("tui.select.confirm", "Submit")})`, 1, 0),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/** Show static informational details and a close hint. */
	showDetails(lines: string[]): void {
		this.authUrl = undefined;
		this.clearDeviceCodeAction();
		this.contentContainer.clear();
		this.authCancelHint = undefined;
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) this.contentContainer.addChild(new Text(line, 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "Close")})`, 1, 0));
		this.tui.requestRender();
	}

	/** Show provider-owned information and terminal hyperlinks. */
	showInfo(message: string, links: readonly AuthInfoLink[] = []): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		for (const link of links) {
			const url = displayUrl(link.url);
			const text = link.label ? `${link.label}: ${url}` : url;
			this.contentContainer.addChild(new Text(theme.fg("accent", webLink(text, url)), 1, 0));
		}
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.removeAuthCancelHint();
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "Cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): boolean {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return true;
		}
		if (this.authUrl && kb.matches(data, "app.auth.copyUrl")) {
			void this.authUrl.copy();
			return true;
		}

		if (
			this.deviceCodeAction &&
			!this.inputResolver &&
			!this.signal.aborted &&
			this.focused &&
			kb.matches(data, "tui.select.confirm")
		) {
			const action = this.deviceCodeAction;
			this.deviceCodeAction = undefined;
			this.activateDeviceCode(action.info, action.hint);
			this.tui.requestRender();
			return true;
		}

		// Pass to input
		this.input.handleInput(data);
		return true;
	}
}
