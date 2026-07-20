import type { HostInputFormRequest } from "../../core/extensions/ui-types.ts";
import {
	parseInteractiveEngineCommand,
	serializeInteractiveEngineMessage,
	type InteractiveEngineMessage,
} from "./protocol.ts";

interface ActiveForm {
	settled: boolean;
	resolve: (values: Record<string, string> | undefined) => void;
}

/** Child-side owner for host-native input forms. */
export class EngineInputFormService {
	private readonly active = new Map<string, ActiveForm>();
	private readonly write: (line: string) => void;
	private nextId = 0;
	constructor(write: (line: string) => void) {
		this.write = write;
	}

	open(request: HostInputFormRequest): Promise<Record<string, string> | undefined> {
		const componentId = `input_form_${++this.nextId}`;
		let resolveResult!: (values: Record<string, string> | undefined) => void;
		const result = new Promise<Record<string, string> | undefined>((resolve) => { resolveResult = resolve; });
		const record: ActiveForm = {
			settled: false,
			resolve: (values) => {
				if (record.settled) return;
				record.settled = true;
				this.active.delete(componentId);
				resolveResult(values);
			},
		};
		this.active.set(componentId, record);
		this.send({ type: "engine_input_form_open", componentId, title: request.title, fields: request.fields.map((field) => ({ ...field, choices: field.choices ? [...field.choices] : undefined })) });
		return result;
	}

	handleLine(line: string): boolean {
		const command = parseInteractiveEngineCommand(line);
		if (!command || !command.type.startsWith("engine_input_form_")) return false;
		const record = this.active.get(command.componentId);
		if (!record) return true;
		if (command.type === "engine_input_form_submit") record.resolve(command.values);
		else if (command.type === "engine_input_form_cancel") record.resolve(undefined);
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
