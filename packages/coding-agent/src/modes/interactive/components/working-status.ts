import { type Component, Text } from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import {
	type AtomicWorkingPalette,
	AtomicWorkingStatusComponent,
	atomicWorkingFrame,
	DEFAULT_WORKING_MESSAGE,
} from "./atomic-working-status.ts";
import { normalizeWorkingRunSnapshot, type WorkingRunMetaInput } from "./working-run-meter.ts";

export interface WorkingStatusComponentOptions {
	/** Explicit caller-owned indicator frame; omitted uses Atomic's one-cell identity. */
	spinner?: string;
	frame?: number;
	message?: string;
	spinnerColor?: (text: string) => string;
	spinnerBoldColor?: (text: string) => string;
	palette?: AtomicWorkingPalette | (() => AtomicWorkingPalette);
	messageColor?: (text: string) => string;
	meta?: WorkingRunMetaInput;
	logo?: boolean;
}

export class WorkingStatusComponent implements Component {
	private readonly options: WorkingStatusComponentOptions;

	constructor(options: WorkingStatusComponentOptions = {}) {
		this.options = options;
	}

	render(width: number): string[] {
		const message = this.options.message ?? DEFAULT_WORKING_MESSAGE;
		const spinnerColor = this.options.spinnerColor ?? ((text: string) => theme.fg("accent", text));
		const messageColor = this.options.messageColor ?? ((text: string) => theme.fg("muted", text));
		if (this.options.spinner !== undefined) {
			const indicator = this.options.spinner ? `${spinnerColor(this.options.spinner)} ` : "";
			return ["", ...new Text(`${indicator}${messageColor(message)}`, 1, 0).render(width)];
		}
		return new AtomicWorkingStatusComponent({
			frame: this.options.frame ?? atomicWorkingFrame(),
			message,
			spinnerColor: this.options.spinnerColor,
			spinnerBoldColor: this.options.spinnerBoldColor,
			palette: this.options.palette,
			messageColor,
			meta: this.options.meta ? normalizeWorkingRunSnapshot(this.options.meta) : undefined,
			logo: this.options.logo,
		}).render(width);
	}

	invalidate(): void {}
}
