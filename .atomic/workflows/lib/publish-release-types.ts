export type ReleaseKind = "release" | "prerelease";
export type ReleaseStatus = "completed" | "blocked" | "failed";
export type ReleasePrState = "OPEN" | "MERGED";

export type ValidatedRelease = {
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
};

export type PublishReleaseOutput = {
  readonly status: ReleaseStatus;
  readonly target_version: string;
  readonly release_kind: ReleaseKind;
  readonly branch: string;
  readonly pr_url?: string;
  readonly tag?: string;
  readonly summary: string;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type CommandResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type PullRequestReferenceVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly prUrl: string;
      readonly prNumber: number;
      readonly headRefOid: string;
      readonly state: ReleasePrState;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly prUrl?: string;
      readonly prNumber?: number;
    };

export type PullRequestMergeVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly mergeCommitOid: string;
      readonly prUrl?: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly prUrl?: string;
    };

export type PullRequestChecksVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly checkCount: number;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly pending?: boolean;
    };

export type PublishWorkflowRunVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly runId: number;
      readonly runUrl?: string;
      readonly status: string;
      readonly conclusion: string;
      readonly headSha?: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly runId?: number;
      readonly runUrl?: string;
      readonly pending?: boolean;
    };

export type PublishWorkflowRunReference =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly runId: number;
      readonly runUrl?: string;
      readonly status: string;
      readonly conclusion?: string;
      readonly headSha?: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
    };
