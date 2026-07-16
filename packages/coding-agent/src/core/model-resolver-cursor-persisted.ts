import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionMode } from "./extensions/index.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { isAuthenticatedCursorRouteModel, isExactCursorProvider } from "./cursor-model-reference.ts";

export interface DeferredCursorModelReference {
  readonly kind: "session" | "default";
  readonly id: string;
}

interface CursorDiscoverySession {
  discoverExtensionModels(mode: ExtensionMode): Promise<void>;
  setModel(model: Model<Api>): Promise<void>;
}

export function selectDeferredCursorModelReference(input: {
  readonly explicitModel: Model<Api> | undefined;
  readonly sessionModel: { readonly provider: string; readonly modelId: string } | undefined;
  readonly defaultProvider: string | undefined;
  readonly defaultModelId: string | undefined;
}): DeferredCursorModelReference | undefined {
  if (input.explicitModel) return undefined;
  if (input.sessionModel) {
    return isExactCursorProvider(input.sessionModel.provider)
      ? { kind: "session", id: input.sessionModel.modelId }
      : undefined;
  }
  if (isExactCursorProvider(input.defaultProvider) && input.defaultModelId !== undefined) {
    return { kind: "default", id: input.defaultModelId };
  }
  return undefined;
}

export async function recoverDeferredCursorModel(input: {
  readonly reference: DeferredCursorModelReference;
  readonly session: CursorDiscoverySession;
  readonly modelRegistry: ModelRegistry;
  readonly mode?: ExtensionMode;
}): Promise<string | undefined> {
  try {
    await input.session.discoverExtensionModels(input.mode ?? "print");
  } catch {
    return cursorReselectionMessage(input.reference);
  }
  const matches = input.modelRegistry.getAll().filter(
    (model) => isAuthenticatedCursorRouteModel(model) && model.id === input.reference.id,
  );
  // Persisted provider/ID state carries no occurrence identity. It may recover
  // only an unambiguous singleton; duplicates require explicit reselection.
  const exact = matches.length === 1 ? matches[0] : undefined;
  if (!exact || !input.modelRegistry.hasConfiguredAuth(exact)) {
    return cursorReselectionMessage(input.reference);
  }
  await input.session.setModel(exact);
  return undefined;
}

export function cursorReselectionMessage(reference: DeferredCursorModelReference): string {
  const action = reference.kind === "session" ? "restore" : "select saved";
  return `Could not ${action} Cursor model cursor/${reference.id}. Cursor model IDs changed; reselect an exact model with --list-models.`;
}
