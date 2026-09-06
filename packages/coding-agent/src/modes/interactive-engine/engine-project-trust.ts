import type { ExtensionRunner } from "../../core/extensions/runner.js";
import { parseInteractiveEngineCommand } from "./protocol.js";

/** Child-side lifecycle tracking for trust dialogs owned by the terminal host. */
export class EngineProjectTrustService {
	private readonly active = new Map<string, () => void>();

	private readonly getRunner: () => ExtensionRunner;

	constructor(getRunner: () => ExtensionRunner) {
		this.getRunner = getRunner;
	}

	handleLine(line: string): boolean {
		const command = parseInteractiveEngineCommand(line);
		if (command?.type === "engine_project_trust_end") {
			this.active.get(command.componentId)?.();
			this.active.delete(command.componentId);
			return true;
		}
		if (command?.type !== "engine_project_trust_start") return false;
		if (this.active.has(command.componentId)) return true;
		void this.getRunner().withProjectTrustPrompt(
			command.kind,
			command.title,
			() => new Promise<void>((resolve) => this.active.set(command.componentId, resolve)),
		);
		return true;
	}

	dispose(): void {
		for (const finish of this.active.values()) finish();
		this.active.clear();
	}
}
