import type { BlueprintFailure, BlueprintLayer, BlueprintLayerState } from "./build.ts";
import type { BlueprintDocument, RunStep } from "./types.ts";

/** The custom message type of the blueprint context a resumed session's first turn carries. */
export const BLUEPRINT_CONTEXT_TYPE = "blueprint-context";

const MAX_OUTPUT_LINES = 20;
const MAX_OUTPUT_CHARACTERS = 1500;

function describeState(state: BlueprintLayerState): string {
	switch (state.kind) {
		case "built":
			return state.action === "rebuild"
				? "ran during this resume's build (initialize and maintenance)"
				: "ran during this resume's build: maintenance only, initialize was skipped because this blueprint is unchanged since its last successful build on this machine";
		case "not-run":
			switch (state.reason) {
				case "untrusted":
					return "NOT YET RUN on this machine: the project is not trusted, so the build was skipped";
				case "in-place":
					return "NOT YET RUN on this machine: this checkout is used as it is and no build ran for it";
				case "earlier":
					return "SET UP EARLIER on this machine: a previous resume built this worktree, and maintenance was not run again";
				case "build-failed":
					return "NOT CONFIRMED: the build stopped before it finished (see the failure above), so these steps may not have run";
				case "global-failed":
					return "NOT RUN: the global blueprint failed before this one was built";
				case "skipped":
					return "NOT YET RUN on this machine: the build was skipped";
			}
			return "NOT YET RUN on this machine";
		case "failed":
			return state.section === "maintenance" || state.section === "post-build"
				? "PARTIAL: the build of this blueprint stopped at the failing step below; the maintenance steps before it ran"
				: "NOT RUN: the build of this blueprint failed before its maintenance, see the failing step below";
		case "no-document":
			return "";
	}
}

function tailOf(output: string): string {
	const lines = output.trimEnd().split("\n").slice(-MAX_OUTPUT_LINES).join("\n");
	return lines.length > MAX_OUTPUT_CHARACTERS ? lines.slice(lines.length - MAX_OUTPUT_CHARACTERS) : lines;
}

function describeFailure(failure: BlueprintFailure): string[] {
	const lines = [`Failure: ${failure.error.message}`];
	if (failure.logPath !== null) lines.push(`Build log: ${failure.logPath}`);
	const tail = tailOf(failure.outputTail);
	if (tail !== "") lines.push("Output tail:", ...tail.split("\n").map((line) => `  ${line}`));
	return lines;
}

function describeSteps(steps: readonly RunStep[]): string[] {
	return steps.flatMap((step, index) => [
		`  ${index + 1}. ${step.name ?? "maintenance step"}`,
		...step.run
			.trimEnd()
			.split("\n")
			.map((line) => `     ${line}`),
	]);
}

function describeDocument(document: BlueprintDocument): string[] {
	const lines: string[] = [];
	if (document.maintenance.length > 0) lines.push("Maintenance steps:", ...describeSteps(document.maintenance));
	if (document.knowledge.length > 0) {
		lines.push("Knowledge:");
		for (const item of document.knowledge) {
			lines.push(
				`  ${item.name}:`,
				...item.contents
					.trimEnd()
					.split("\n")
					.map((line) => `    ${line}`),
			);
		}
	}
	return lines;
}

function describeLayer(layer: BlueprintLayer): string[] {
	if (layer.state.kind === "no-document") return [];
	const header = [
		`scope: ${layer.scope}`,
		`blueprint: ${layer.blueprint}`,
		...(layer.directory === null ? [] : [`workspace: ${layer.directory}`]),
		...(layer.root === null ? [] : [`repository: ${layer.root}`]),
		`state: ${describeState(layer.state)}`,
	];
	const failure = layer.state.kind === "failed" ? describeFailure(layer.state.failure) : [];
	const content = layer.document === undefined ? [] : describeDocument(layer.document);
	if (failure.length === 0 && content.length === 0) return [];
	return ["<blueprint>", ...header, ...failure, ...content, "</blueprint>"];
}

/**
 * What the agent is told in the first turn of a resumed session: each blueprint's `maintenance` steps and `knowledge`
 * items, labelled with what the build did (ran, or not yet run when it was skipped or partial), and the failing step
 * of a blueprint that failed. Undefined when no blueprint has anything to say, so a project without blueprints adds
 * nothing to the conversation.
 */
export function renderBlueprintContext(layers: readonly BlueprintLayer[]): string | undefined {
	const blocks = layers.flatMap(describeLayer);
	if (blocks.length === 0) return undefined;
	return [
		"<blueprint_context>",
		"This session was resumed. The blueprints below (.atomic/blueprint.yaml files) describe how its environment is set up. Maintenance steps are NOT run automatically at session start: re-run the ones you need when dependencies changed or a blueprint says its steps have not run yet. Knowledge items are reference information for this project.",
		"When a blueprint failed or did not run, fix the environment, then update that blueprint in the same change so the next restore succeeds. Never write secrets into a blueprint.",
		...blocks,
		"</blueprint_context>",
	].join("\n");
}
