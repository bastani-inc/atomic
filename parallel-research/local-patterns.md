## Review Findings

### 1) Atomic/pi image handling is capability-gated at render time
**Found in**: `packages/coding-agent/src/core/tools/render-utils.ts:4,69`  
**Used for**: Tool results that include image blocks

```ts
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
...
if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
  ...
  output = output ? `${output}\n${imageIndicators}` : imageIndicators;
}
```

**Pattern**:
- If UI/terminal cannot show images, the result is downgraded to a textual fallback.
- The image data is not silently lost; it becomes a visible placeholder via `imageFallback(...)`.

---

### 2) Atomic/pi model metadata declares image input capability explicitly
**Found in**: `packages/coding-agent/src/core/model-registry.ts:156,176,706`  
**Used for**: Model capability declaration and defaulting

```ts
input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
...
input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
```

**Pattern**:
- Model definitions can declare `input: ["text", "image"]`.
- If omitted, the default is text-only.
- This capability is stored on the model object and can drive routing/UX decisions.

---

### 3) Atomic/pi surfaces image capability in model listing UX
**Found in**: `packages/coding-agent/src/cli/list-models.ts:67`  
**Used for**: User-facing model catalog

```ts
images: m.input.includes("image") ? "yes" : "no",
```

**Pattern**:
- Image support is exposed in the model list as an explicit yes/no column.
- Capability is treated as first-class metadata, not inferred ad hoc.

---

### 4) Atomic/pi emits a non-vision guidance note when a model cannot accept images
**Found in**: `packages/coding-agent/src/core/tools/read.ts:108-112,308`  
**Used for**: Reading image files on text-only models

```ts
function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
  if (!model || model.input.includes("image")) {
    return undefined;
  }
  return "[Current model does not support images. The image will be omitted from this request.]";
}
```

**Pattern**:
- The file-read tool does not hard fail immediately.
- It attaches a user-facing note explaining the omission when the current model is text-only.

---

### 5) Atomic/pi uses a hard preflight rejection for Cursor image input
**Found in**: `packages/cursor/src/stream.ts:36,115-116`  
**Used for**: Cursor provider request validation

```ts
const CURSOR_IMAGE_INPUT_ERROR =
  "Cursor supports text input only; images/screenshots are not supported by Cursor's headless provider API. Remove image content or switch to a vision-capable provider.";
...
if (hasImageInput(context)) {
  throw new Error(CURSOR_IMAGE_INPUT_ERROR);
}
```

**Pattern**:
- Cursor is rejected before the request is sent.
- The error message gives direct remediation: remove images or choose a vision-capable provider.

---

### 6) Atomic/pi documents Cursor as text-only in provider docs
**Found in**: `packages/coding-agent/docs/providers.md:49-50` and `packages/cursor/README.md:15`  
**Used for**: User-facing provider limitations

```md
- Text input is supported; vision/image input is rejected with a clear error.
```

```md
- Text input only. Images/screenshots are not supported by Cursor's headless provider API; remove image content or switch to a vision-capable provider.
```

**Pattern**:
- The limitation is documented in both the central provider guide and the Cursor package README.
- Guidance is consistent with the runtime error text.

---

### 7) Atomic/pi has provider/model fallback logic, but not image-capability fallback
**Found in**: `packages/coding-agent/src/core/model-resolver.ts:724-761`  
**Used for**: Restoring unavailable models

```ts
if (currentModel) {
  return { model: currentModel, fallbackMessage: ... };
}
...
if (!fallbackModel) {
  fallbackModel = availableModels[0];
}
```

**Pattern**:
- There is fallback/routing for missing models or auth state.
- I did not find a comparable automatic fallback that rewrites an image-bearing request to another provider/model.

---

## Cursor Comparison

### Cursor provider status
- Cursor is **text-only** in this codebase.
- It performs a **preflight error** on any image input.
- It already has the clearest user-facing guidance among provider integrations.

### Codebase-consistent handling if Cursor cannot accept images
- Keep the **hard preflight rejection** in the Cursor stream adapter.
- Keep the **explicit remediation text**: remove images or switch to a vision-capable provider.
- Align the Cursor provider docs/README with the same wording.
- Do **not** attempt silent fallback inside Cursor transport; the codebase’s existing pattern is to fail early with clear guidance for unsupported provider capabilities.

---

## Residual Risks
- `packages/cursor/src/stream.ts` rejects image input only after context inspection; if upstream code bypasses that path, the error won’t trigger.
- There is no existing automatic provider-switch mechanism for image-capable fallback in the Cursor path.
- User-facing guidance is clear, but the rest of the app may still surface the generic provider error unless wrapped higher up.