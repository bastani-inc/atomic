import { APP_NAME, BUILT_IN_PROVIDER_DISPLAY_NAMES, BUILTIN_SLASH_COMMANDS, defaultModelPerProvider, fs, getProviders, SessionManager, Text, type Api, type Model } from "./interactive-mode-deps.ts";
import type { Expandable } from "./interactive-mode-types.ts";

export function isExpandable(obj: unknown): obj is Expandable {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "setExpanded" in obj &&
    typeof obj.setExpanded === "function"
  );
}

export class ExpandableText extends Text implements Expandable {
  private expanded: boolean;

  declare private readonly getCollapsedText: () => string;
  declare private readonly getExpandedText: () => string;

  constructor(
    getCollapsedText: () => string,
    getExpandedText: () => string,
    expanded = false,
    paddingX = 0,
    paddingY = 0,
  ) {
    super(
      expanded ? getExpandedText() : getCollapsedText(),
      paddingX,
      paddingY,
    );
    this.getCollapsedText = getCollapsedText;
    this.getExpandedText = getExpandedText;
    this.expanded = expanded;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.refresh();
  }

  refresh(): void {
    this.setText(this.expanded ? this.getExpandedText() : this.getCollapsedText());
  }
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

export function isDeadTerminalError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

export const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
  "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

export const BUILTIN_SLASH_COMMAND_NAMES = new Set(
  BUILTIN_SLASH_COMMANDS.map((command) => command.name),
);

export function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

export function isUnknownModel(model: Model<Api> | undefined): boolean {
  return (
    !!model &&
    model.provider === "unknown" &&
    model.id === "unknown" &&
    model.api === "unknown"
  );
}

function quoteIfNeeded(value: string): string {
  if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
  if (!process.stdout.isTTY) return undefined;
  if (!sessionManager.isPersisted()) return undefined;

  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

  const args = [APP_NAME];
  if (!sessionManager.usesDefaultSessionDir()) {
    args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
  }
  args.push("--session", sessionManager.getSessionId());
  return args.join(" ");
}

export function hasDefaultModelProvider(
  providerId: string,
): providerId is keyof typeof defaultModelPerProvider {
  return providerId in defaultModelPerProvider;
}

export const BEDROCK_PROVIDER_ID = "amazon-bedrock";

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

export function isApiKeyLoginProvider(
  providerId: string,
  oauthProviderIds: ReadonlySet<string>,
  builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
  if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
    return true;
  }
  if (builtInProviderIds.has(providerId)) {
    return false;
  }
  return !oauthProviderIds.has(providerId);
}
