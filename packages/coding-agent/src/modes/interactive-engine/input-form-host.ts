import type { ExtensionUIContext, HostInputFormRequest } from "../../core/extensions/index.ts";
import {
	mountHostInputForm,
	type HostInputFormMount,
} from "../interactive/components/host-input-form-mount.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import type { InteractiveEngineMessage } from "./protocol.ts";

/** Host-side controller that keeps form input/state entirely in the terminal process. */
export class InputFormHostController {
	private readonly mounted = new Map<string, HostInputFormMount>();
	private readonly runtime: IsolatedInteractiveRuntime;
	private readonly ui: ExtensionUIContext;
	private readonly unsubscribe: () => void;
	constructor(runtime: IsolatedInteractiveRuntime, ui: ExtensionUIContext) {
		this.runtime = runtime;
		this.ui = ui;
		this.unsubscribe = runtime.onEngineMessage((message) => this.handleMessage(message));
	}

	dispose(): void {
		this.unsubscribe();
		this.disposeAll();
	}

	private handleMessage(message: InteractiveEngineMessage): void {
		if (message.type === "engine_ready") {
			this.disposeAll();
			return;
		}
		if (message.type !== "engine_input_form_open") return;
		this.open(message.componentId, { title: message.title, fields: message.fields });
	}

	private open(componentId: string, request: HostInputFormRequest): void {
		if (this.mounted.has(componentId)) return;
		const mount = mountHostInputForm(this.ui, request, {
			onSubmit: (values) => {
				this.mounted.delete(componentId);
				this.runtime.sendEngineCommand({ type: "engine_input_form_submit", componentId, values });
			},
			onCancel: () => {
				this.mounted.delete(componentId);
				this.runtime.sendEngineCommand({ type: "engine_input_form_cancel", componentId });
			},
		});
		this.mounted.set(componentId, mount);
	}

	private disposeAll(): void {
		for (const mount of this.mounted.values()) mount.close();
		this.mounted.clear();
	}
}
