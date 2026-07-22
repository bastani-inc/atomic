import { Text, type Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { atomicWorkingFrame, AtomicWorkingStatusComponent } from "./atomic-working-status.ts";

export interface WorkingStatusComponentOptions {
	/** Explicit caller-owned indicator frame; omitted uses Atomic's one-cell identity. */
	spinner?: string;
	frame?: number;
	message?: string;
	spinnerColor?: (text: string) => string;
	spinnerBoldColor?: (text: string) => string;
	messageColor?: (text: string) => string;
}

export class WorkingStatusComponent implements Component {
	private readonly options: WorkingStatusComponentOptions;

	constructor(options: WorkingStatusComponentOptions = {}) {
		this.options = options;
	}

	render(width: number): string[] {
		const message = this.options.message ?? "Working...";
		const spinnerColor = this.options.spinnerColor ?? ((text: string) => theme.fg("accent", text));
		const messageColor = this.options.messageColor ?? ((text: string) => theme.fg("muted", text));
		if (this.options.spinner !== undefined) {
			const indicator = this.options.spinner ? `${spinnerColor(this.options.spinner)} ` : "";
			return ["", ...new Text(`${indicator}${messageColor(message)}`, 1, 0).render(width)];
		}
		return new AtomicWorkingStatusComponent({
			frame: this.options.frame ?? atomicWorkingFrame(),
			message,
			spinnerColor,
			spinnerBoldColor: this.options.spinnerBoldColor,
			messageColor,
		}).render(width);
	}

	invalidate(): void {}
}
