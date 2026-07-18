import { createHash } from "node:crypto";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkflowSerializableObject } from "./types.js";

/** Compute a collision-resistant digest over canonical JSON. */
export function durableHash(
  value: WorkflowSerializableValue | WorkflowSerializableObject,
): string {
  const canonical = canonicalJsonString(value);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `h${digest.slice(0, 32)}`;
}

function canonicalJsonString(value: WorkflowSerializableValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonString).join(",")}]`;
  const object = value as WorkflowSerializableObject;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonString(object[key]!)}`).join(",")}}`;
}
