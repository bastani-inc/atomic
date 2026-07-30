import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../rpc/rpc-types.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";

/** Requests that mount a host dialog and therefore need generation ownership. */
const MOUNTING_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

async function handleRequest(
	ui: ExtensionUIContext,
	request: RpcExtensionUIRequest,
	signal: AbortSignal | undefined,
): Promise<RpcExtensionUIResponse | undefined> {
	switch (request.method) {
		case "select": {
			const value = await ui.select(request.title, request.options, { timeout: request.timeout, signal });
			return value === undefined
				? { type: "extension_ui_response", id: request.id, cancelled: true }
				: { type: "extension_ui_response", id: request.id, value };
		}
		case "confirm": {
			const confirmed = await ui.confirm(request.title, request.message, { timeout: request.timeout, signal });
			return { type: "extension_ui_response", id: request.id, confirmed };
		}
		case "input": {
			const value = await ui.input(request.title, request.placeholder, { timeout: request.timeout, signal });
			return value === undefined
				? { type: "extension_ui_response", id: request.id, cancelled: true }
				: { type: "extension_ui_response", id: request.id, value };
		}
		case "editor": {
			const value = await ui.editor(request.title, request.prefill, { signal });
			return value === undefined
				? { type: "extension_ui_response", id: request.id, cancelled: true }
				: { type: "extension_ui_response", id: request.id, value };
		}
		case "notify":
			ui.notify(request.message, request.notifyType);
			return undefined;
		case "setStatus":
			ui.setStatus(request.statusKey, request.statusText);
			return undefined;
		case "setWidget":
			ui.setWidget(request.widgetKey, request.widgetLines, { placement: request.widgetPlacement });
			return undefined;
		case "setTitle":
			ui.setTitle(request.title);
			return undefined;
		case "set_editor_text":
			ui.setEditorText(request.text);
			return undefined;
	}
}

/**
 * Generation-owned host dialogs and line widgets for the isolated engine.
 *
 * `select`, `confirm`, `input`, and `editor` mount real host components and can
 * outlive the engine child that asked for them. Without ownership a dead
 * generation left its dialog on screen forever, its host promise unsettled, and
 * could answer through the replacement child's writer. Each request is recorded
 * with the generation that issued it; when that generation ends the mount is
 * aborted — closing only its own instance — and any answer is suppressed.
 *
 * Line widgets (`setWidget` with `string[]`) have the same problem without any
 * component to close: they are plain host state keyed by name, so the key is
 * tracked against its latest writer and released only if that writer's
 * generation is the one that died.
 */
export class EngineDialogHostController {
	private readonly runtime: IsolatedInteractiveRuntime;
	private readonly ui: ExtensionUIContext;
	private readonly records = new Map<string, { generation: number; abort: AbortController }>();
	/** Line-widget key -> generation that last wrote it. */
	private readonly widgetOwners = new Map<string, number>();
	private readonly unsubscribeHandler: () => void;
	private readonly unsubscribeGenerationEnded: () => void;

	constructor(runtime: IsolatedInteractiveRuntime, ui: ExtensionUIContext) {
		this.runtime = runtime;
		this.ui = ui;
		this.unsubscribeHandler = runtime.setExtensionUIHandler((request) => this.handle(request));
		this.unsubscribeGenerationEnded = runtime.onGenerationEnded((event) => this.disposeGeneration(event.generation));
	}

	dispose(): void {
		this.unsubscribeHandler();
		this.unsubscribeGenerationEnded();
		this.abortAll();
		for (const key of [...this.widgetOwners.keys()]) this.ui.setWidget(key, undefined);
		this.widgetOwners.clear();
	}

	/** Close every dialog and release every widget key owned by an ended generation. */
	disposeGeneration(generation: number): void {
		for (const [id, record] of [...this.records]) {
			if (record.generation !== generation) continue;
			this.records.delete(id);
			record.abort.abort();
		}
		for (const [key, owner] of [...this.widgetOwners]) {
			// A newer generation that rewrote this key owns it now; clearing here
			// would wipe live content the replacement child just published.
			if (owner !== generation) continue;
			this.widgetOwners.delete(key);
			this.ui.setWidget(key, undefined);
		}
	}

	private abortAll(): void {
		for (const [, record] of [...this.records]) record.abort.abort();
		this.records.clear();
	}

	private async handle(request: RpcExtensionUIRequest): Promise<RpcExtensionUIResponse | undefined> {
		if (request.method === "setWidget") {
			if (request.widgetLines === undefined) this.widgetOwners.delete(request.widgetKey);
			else this.widgetOwners.set(request.widgetKey, this.runtime.getEngineGeneration());
			return handleRequest(this.ui, request, undefined);
		}
		if (!MOUNTING_METHODS.has(request.method)) return handleRequest(this.ui, request, undefined);
		const abort = new AbortController();
		const generation = this.runtime.getEngineGeneration();
		this.records.set(request.id, { generation, abort });
		let response: RpcExtensionUIResponse | undefined;
		try {
			response = await handleRequest(this.ui, request, abort.signal);
		} finally {
			// Only the owning record may be removed: a late settle must not delete a
			// newer record that happens to share this id.
			if (this.records.get(request.id)?.abort === abort) this.records.delete(request.id);
		}
		// The generation that asked is gone, so the writer now points at a
		// replacement child. Answering would deliver this reply to the wrong engine.
		if (abort.signal.aborted) return undefined;
		return response;
	}
}
