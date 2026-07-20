import type { TUI } from "@earendil-works/pi-tui";
import type {
	ExtensionUIContext,
	HostInputFormRequest,
} from "../../../core/extensions/ui-types.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme } from "../theme/theme.ts";
import { HostInputFormComponent } from "./host-input-form.ts";

export type HostInputFormUi = Pick<ExtensionUIContext, "custom"> &
	Partial<Pick<ExtensionUIContext, "setWorkingVisible">>;

export interface HostInputFormMountDelegate {
	onSubmit(values: Record<string, string>): void;
	onCancel(): void;
}

export interface HostInputFormMount {
	close(): void;
}

/** Mount the real form inline in the terminal host. */
export function mountHostInputForm(
	ui: HostInputFormUi,
	request: HostInputFormRequest,
	delegate: HostInputFormMountDelegate,
): HostInputFormMount {
	let done: ((result: undefined) => void) | undefined;
	let settled = false;
	let closedBeforeMount = false;
	let workingHidden = true;
	ui.setWorkingVisible?.(false);
	const restoreWorking = (): void => {
		if (!workingHidden) return;
		workingHidden = false;
		ui.setWorkingVisible?.(true);
	};
	const finish = (notify?: () => void): void => {
		if (settled) return;
		settled = true;
		try {
			notify?.();
		} finally {
			try {
				done?.(undefined);
			} finally {
				restoreWorking();
			}
		}
	};
	const factory = (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		complete: (result: undefined) => void,
	): HostInputFormComponent => {
		done = complete;
		if (closedBeforeMount) complete(undefined);
		return new HostInputFormComponent(tui, theme, keybindings, request, {
			onSubmit: (values) => finish(() => delegate.onSubmit(values)),
			onCancel: () => finish(() => delegate.onCancel()),
		});
	};
	try {
		void Promise.resolve(ui.custom<undefined>(factory, { overlay: false })).catch(() => {
			finish(() => delegate.onCancel());
		}).finally(() => {
			if (settled) restoreWorking();
			else finish(() => delegate.onCancel());
		});
	} catch {
		finish(() => delegate.onCancel());
	}
	return {
		close: () => {
			if (settled) return;
			if (!done) closedBeforeMount = true;
			finish();
		},
	};
}

/** Non-isolated implementation of the public capability. */
export function openLocalHostInputForm(
	ui: HostInputFormUi,
	request: HostInputFormRequest,
): Promise<Record<string, string> | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (values: Record<string, string> | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(values);
		};
		mountHostInputForm(ui, request, {
			onSubmit: (values) => settle(values),
			onCancel: () => settle(undefined),
		});
	});
}
