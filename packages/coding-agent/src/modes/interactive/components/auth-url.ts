import { Container, hyperlink, Text, type TUI } from "@earendil-works/pi-tui";
import { copyToClipboard } from "../../../utils/clipboard.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";

export class AuthUrlComponent extends Container {
	readonly url: string;
	private readonly tui: TUI;
	private readonly hint: Text;

	constructor(tui: TUI, url: string) {
		super();
		this.tui = tui;
		this.url = url;
		this.addChild(new Text(theme.fg("accent", hyperlink(url, url)), 1, 0));
		this.hint = new Text("", 1, 0);
		this.addChild(this.hint);
		this.setHint(keyHint("app.auth.copyUrl", "to copy"));
	}

	private setHint(suffix: string): void {
		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		this.hint.setText(`${theme.fg("dim", hyperlink(clickHint, this.url))} ${theme.fg("dim", "•")} ${suffix}`);
		this.tui.requestRender();
	}

	async copy(): Promise<void> {
		try {
			await copyToClipboard(this.url);
			this.setHint(theme.fg("success", "Copied URL to clipboard"));
		} catch (error) {
			this.setHint(theme.fg("error", error instanceof Error ? error.message : String(error)));
		}
	}
}
