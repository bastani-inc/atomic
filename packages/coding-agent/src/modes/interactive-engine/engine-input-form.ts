import type { HostInputFormRequest } from "../../core/extensions/ui-types.js";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineCommand,
	serializeInteractiveEngineMessage,
} from "./protocol.ts";

interface ActiveForm {
	settled: boolean;
	resolve: (values: Record<string, string> | undefined) => void;
	reject: (error: Error) => void;
}

/** Child-side owner for host-native input forms. */
export class EngineInputFormService {
	private readonly active = new Map<string, ActiveForm>();
	private readonly write: (line: string) => void;
	private nextId = 0;
	constructor(write: (line: string) => void) {
		this.write = write;
	}

	async open(request: HostInputFormRequest, signal?: AbortSignal): Promise<Record<string, string> | undefined> {
		if (signal?.aborted) return undefined;
		const componentId = `input_form_${++this.nextId}`;
		const frame = serializeInteractiveEngineMessage({
			type: "engine_input_form_open",
			componentId,
			title: request.title,
			fields: request.fields.map((field) => ({ ...field, choices: field.choices ? [...field.choices] : undefined })),
			...(request.heading !== undefined ? { heading: request.heading } : {}),
			...(request.submitLabel !== undefined ? { submitLabel: request.submitLabel } : {}),
		});
		let resolveResult!: (values: Record<string, string> | undefined) => void;
		let rejectResult!: (error: Error) => void;
		const result = new Promise<Record<string, string> | undefined>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const onAbort = () => {
			record.resolve(undefined);
			try {
				this.send({ type: "engine_input_form_close", componentId });
			} catch {}
		};
		const settle = (): boolean => {
			if (record.settled) return false;
			record.settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.active.delete(componentId);
			return true;
		};
		const record: ActiveForm = {
			settled: false,
			resolve: (values) => {
				if (settle()) resolveResult(values);
			},
			reject: (error) => {
				if (settle()) rejectResult(error);
			},
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.active.set(componentId, record);
		try {
			this.write(frame);
		} catch (error) {
			record.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return result;
	}

	handleLine(line: string): boolean {
		const command = parseInteractiveEngineCommand(line);
		if (!command?.type.startsWith("engine_input_form_")) return false;
		const record = this.active.get(command.componentId);
		if (!record) return true;
		if (command.type === "engine_input_form_submit") record.resolve(command.values);
		else if (command.type === "engine_input_form_cancel") record.resolve(undefined);
		else if (command.type === "engine_input_form_error") record.reject(new Error(command.message));
		return true;
	}

	dispose(): void {
		for (const record of this.active.values()) record.resolve(undefined);
		this.active.clear();
	}

	private send(message: InteractiveEngineMessage): void {
		this.write(serializeInteractiveEngineMessage(message));
	}
}
