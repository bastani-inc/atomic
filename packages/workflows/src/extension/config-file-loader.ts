import {
  WORKFLOW_LIFECYCLE_NOTICE_KINDS,
  type WorkflowLifecycleNoticeKind,
} from "./lifecycle-notifications.js";
import type { ConfigDiagnostic, WorkflowExtensionConfig } from "./config-loader.js";

const WORKFLOW_LIFECYCLE_NOTICE_KIND_SET = new Set<string>(WORKFLOW_LIFECYCLE_NOTICE_KINDS);

async function tryReadFile(filePath: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isWorkflowLifecycleNoticeKind(value: unknown): value is WorkflowLifecycleNoticeKind {
  return typeof value === "string" && WORKFLOW_LIFECYCLE_NOTICE_KIND_SET.has(value);
}

function validateConfig(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "config must be a JSON object";
  }
  const c = value as Record<string, unknown>;

  if ("maxDepth" in c && (typeof c["maxDepth"] !== "number" || !Number.isInteger(c["maxDepth"]) || (c["maxDepth"] as number) < 0)) {
    return `"maxDepth" must be a non-negative integer, got ${JSON.stringify(c["maxDepth"])}`;
  }

  if ("defaultConcurrency" in c && (typeof c["defaultConcurrency"] !== "number" || !Number.isInteger(c["defaultConcurrency"]) || (c["defaultConcurrency"] as number) < 1)) {
    return `"defaultConcurrency" must be a positive integer, got ${JSON.stringify(c["defaultConcurrency"])}`;
  }

  if ("persistRuns" in c && typeof c["persistRuns"] !== "boolean") {
    return `"persistRuns" must be a boolean, got ${JSON.stringify(c["persistRuns"])}`;
  }

  if ("statusFile" in c && typeof c["statusFile"] !== "boolean") {
    return `"statusFile" must be a boolean, got ${JSON.stringify(c["statusFile"])}`;
  }

  if ("resumeInFlight" in c) {
    const v = c["resumeInFlight"];
    if (v !== "ask" && v !== "auto" && v !== "never") {
      return `"resumeInFlight" must be "ask", "auto", or "never", got ${JSON.stringify(v)}`;
    }
  }

  if ("workflowNotifications" in c) {
    const value = c["workflowNotifications"];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return `"workflowNotifications" must be a JSON object, got ${JSON.stringify(typeof value)}`;
    }
    const notifications = value as Record<string, unknown>;
    if ("enabled" in notifications && typeof notifications["enabled"] !== "boolean") {
      return `"workflowNotifications.enabled" must be a boolean, got ${JSON.stringify(notifications["enabled"])}`;
    }
    if ("notifyOn" in notifications) {
      const notifyOn = notifications["notifyOn"];
      if (!Array.isArray(notifyOn)) {
        return `"workflowNotifications.notifyOn" must be an array, got ${JSON.stringify(typeof notifyOn)}`;
      }
      if (notifyOn.length === 0) {
        return `"workflowNotifications.notifyOn" must be a non-empty array`;
      }
      for (const item of notifyOn) {
        if (!isWorkflowLifecycleNoticeKind(item)) {
          return `"workflowNotifications.notifyOn" entries must be "completed", "failed", or "awaiting_input", got ${JSON.stringify(item)}`;
        }
      }
    }
  }

  if ("workflows" in c) {
    if (c["workflows"] === null || typeof c["workflows"] !== "object" || Array.isArray(c["workflows"])) {
      return `"workflows" must be a JSON object, got ${JSON.stringify(typeof c["workflows"])}`;
    }
    const wf = c["workflows"] as Record<string, unknown>;
    for (const [name, entry] of Object.entries(wf)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return `"workflows.${name}" must be an object with a "path" field`;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e["path"] !== "string" || (e["path"] as string).trim().length === 0) {
        return `"workflows.${name}.path" must be a non-empty string, got ${JSON.stringify(e["path"])}`;
      }
    }
  }

  return null;
}

export type LoadFileOutcome =
  | { kind: "missing" }
  | { kind: "ok"; parsed: WorkflowExtensionConfig }
  | { kind: "error"; diagnostic: ConfigDiagnostic };

export async function loadConfigFile(filePath: string): Promise<LoadFileOutcome> {
  let text: string | null;
  try {
    text = await tryReadFile(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      diagnostic: {
        level: "error",
        code: "CONFIG_INVALID",
        message: `Failed to read config file: ${msg}`,
        source: filePath,
      },
    };
  }

  if (text === null) {
    return { kind: "missing" };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      diagnostic: {
        level: "error",
        code: "CONFIG_INVALID",
        message: `Invalid JSON in config file: ${msg}`,
        source: filePath,
      },
    };
  }

  const reason = validateConfig(value);
  if (reason !== null) {
    return {
      kind: "error",
      diagnostic: {
        level: "error",
        code: "CONFIG_INVALID",
        message: `Invalid config shape: ${reason}`,
        source: filePath,
      },
    };
  }

  return { kind: "ok", parsed: value as WorkflowExtensionConfig };
}
