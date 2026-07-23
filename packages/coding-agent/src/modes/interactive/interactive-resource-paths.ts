import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type SourceInfo, path, parseGitUrl, theme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.getShortPath = function(this: InteractiveModeBase, fullPath: string, sourceInfo?: SourceInfo): string {
    const baseDir = sourceInfo?.baseDir;
    if (baseDir && this.isPackageSource(sourceInfo)) {
      const relativePath = path.relative(
        path.resolve(baseDir),
        path.resolve(fullPath),
      );
      if (
        relativePath &&
        relativePath !== "." &&
        !relativePath.startsWith("..") &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath)
  ) {
        return relativePath.replace(/\\/g, "/");
      }
    }

    const source = sourceInfo?.source ?? "";
    const npmMatch = fullPath.match(
      /node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/,
    );
    if (npmMatch && source.startsWith("npm:")) {
      return npmMatch[2];
    }

    const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
    if (gitMatch && source.startsWith("git:")) {
      return gitMatch[1];
    }

    return this.formatDisplayPath(fullPath);
  };

InteractiveModeBase.prototype.getCompactPathLabel = function(this: InteractiveModeBase, resourcePath: string, sourceInfo?: SourceInfo): string {
    const shortPath = this.getShortPath(resourcePath, sourceInfo);
    const normalizedPath = shortPath.replace(/\\/g, "/");
    const segments = normalizedPath
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== "~");
    if (segments.length > 0) {
      return segments[segments.length - 1]!;
    }
    return shortPath;
  };

InteractiveModeBase.prototype.getCompactPackageSourceLabel = function(this: InteractiveModeBase, sourceInfo?: SourceInfo): string {
    const source = sourceInfo?.source ?? "";
    if (source.startsWith("npm:")) {
      return source.slice("npm:".length) || source;
    }

    const gitSource = parseGitUrl(source);
    if (gitSource) {
      return gitSource.path || source;
    }

    if (sourceInfo?.origin === "package") {
      return path.basename(source) || source;
    }

    return source;
  };

InteractiveModeBase.prototype.getCompactExtensionLabel = function(this: InteractiveModeBase, resourcePath: string, sourceInfo?: SourceInfo): string {
    if (!this.isPackageSource(sourceInfo)) {
      return this.getCompactPathLabel(resourcePath, sourceInfo);
    }

    const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
    if (!sourceLabel) {
      return this.getCompactPathLabel(resourcePath, sourceInfo);
    }

    const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(
      /\\/g,
      "/",
    );
    const packagePath = shortPath.startsWith("extensions/")
      ? shortPath.slice("extensions/".length)
      : shortPath;
    const parsedPath = path.posix.parse(packagePath);

    if (parsedPath.name === "index") {
      return !parsedPath.dir || parsedPath.dir === "."
        ? sourceLabel
        : `${sourceLabel}:${parsedPath.dir}`;
    }

    return `${sourceLabel}:${packagePath}`;
  };

InteractiveModeBase.prototype.getCompactDisplayPathSegments = function(this: InteractiveModeBase, resourcePath: string): string[] {
    return this.formatDisplayPath(resourcePath)
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== "~");
  };

InteractiveModeBase.prototype.getCompactNonPackageExtensionLabel = function(this: InteractiveModeBase, resourcePath: string, index: number, allPaths: Array<{ path: string; segments: string[] }>): string {
    const segments = allPaths[index]?.segments;
    if (!segments || segments.length === 0) {
      return this.getCompactPathLabel(resourcePath);
    }

    for (
      let segmentCount = 1;
      segmentCount <= segments.length;
      segmentCount += 1
  ) {
      const candidate = segments.slice(-segmentCount).join("/");
      const isUnique = allPaths.every((item, itemIndex) => {
        if (itemIndex === index) {
          return true;
        }
        return item.segments.slice(-segmentCount).join("/") !== candidate;
      });

      if (isUnique) {
        return candidate;
      }
    }

    return segments.join("/");
  };

InteractiveModeBase.prototype.getCompactExtensionLabels = function(this: InteractiveModeBase, extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
    const nonPackageExtensions = extensions
      .map((extension) => {
        const segments = this.getCompactDisplayPathSegments(extension.path);
        const lastSegment = segments[segments.length - 1];
        if (
          segments.length > 1 &&
          (lastSegment === "index.ts" || lastSegment === "index.js")
  ) {
          segments.pop();
        }
        return {
          path: extension.path,
          sourceInfo: extension.sourceInfo,
          segments,
        };
      })
      .filter((extension) => !this.isPackageSource(extension.sourceInfo));

    return extensions.map((extension) => {
      if (this.isPackageSource(extension.sourceInfo)) {
        return this.getCompactExtensionLabel(
          extension.path,
          extension.sourceInfo,
        );
      }

      const nonPackageIndex = nonPackageExtensions.findIndex(
        (item) => item.path === extension.path,
      );
      if (nonPackageIndex === -1) {
        return this.getCompactPathLabel(extension.path, extension.sourceInfo);
      }

      return this.getCompactNonPackageExtensionLabel(
        extension.path,
        nonPackageIndex,
        nonPackageExtensions,
      );
    });
  };

InteractiveModeBase.prototype.getDisplaySourceInfo = function(this: InteractiveModeBase, sourceInfo?: SourceInfo): {
    label: string;
    scopeLabel?: string;
    color: "accent" | "muted";
  } {
    const source = sourceInfo?.source ?? "local";
    const scope = sourceInfo?.scope ?? "project";
    if (source === "local") {
      if (scope === "user") {
        return { label: "user", color: "muted" };
      }
      if (scope === "project") {
        return { label: "project", color: "muted" };
      }
      if (scope === "temporary") {
        return { label: "path", scopeLabel: "temp", color: "muted" };
      }
      return { label: "path", color: "muted" };
    }

    if (source === "cli") {
      return {
        label: "path",
        scopeLabel: scope === "temporary" ? "temp" : undefined,
        color: "muted",
      };
    }

    const scopeLabel =
      scope === "user"
        ? "user"
        : scope === "project"
          ? "project"
          : scope === "temporary"
            ? "temp"
            : undefined;
    return { label: source, scopeLabel, color: "accent" };
  };

InteractiveModeBase.prototype.getScopeGroup = function(this: InteractiveModeBase, sourceInfo?: SourceInfo): "user" | "project" | "path" {
    const source = sourceInfo?.source ?? "local";
    const scope = sourceInfo?.scope ?? "project";
    if (source === "cli" || scope === "temporary") return "path";
    if (scope === "user") return "user";
    if (scope === "project") return "project";
    return "path";
  };

InteractiveModeBase.prototype.isPackageSource = function(this: InteractiveModeBase, sourceInfo?: SourceInfo): boolean {
    const source = sourceInfo?.source ?? "";
    return source.startsWith("npm:") || source.startsWith("git:");
  };

InteractiveModeBase.prototype.buildScopeGroups = function(this: InteractiveModeBase, items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
    scope: "user" | "project" | "path";
    paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
    packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
  }> {
    const groups: Record<
      "user" | "project" | "path",
      {
        scope: "user" | "project" | "path";
        paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
        packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
      }
    > = {
      user: { scope: "user", paths: [], packages: new Map() },
      project: { scope: "project", paths: [], packages: new Map() },
      path: { scope: "path", paths: [], packages: new Map() },
    };

    for (const item of items) {
      const groupKey = this.getScopeGroup(item.sourceInfo);
      const group = groups[groupKey];
      const source = item.sourceInfo?.source ?? "local";

      if (this.isPackageSource(item.sourceInfo)) {
        const list = group.packages.get(source) ?? [];
        list.push(item);
        group.packages.set(source, list);
      } else {
        group.paths.push(item);
      }
    }

    return [groups.project, groups.user, groups.path].filter(
      (group) => group.paths.length > 0 || group.packages.size > 0,
    );
  };

InteractiveModeBase.prototype.formatScopeGroups = function(this: InteractiveModeBase, groups: Array<{
      scope: "user" | "project" | "path";
      paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
      packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
    }>, options: {
      formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
      formatPackagePath: (
        item: { path: string; sourceInfo?: SourceInfo },
        source: string,
      ) => string;
    }): string {
    const lines: string[] = [];

    for (const group of groups) {
      lines.push(`  ${theme.fg("accent", group.scope)}`);

      const sortedPaths = [...group.paths].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      for (const item of sortedPaths) {
        lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
      }

      const sortedPackages = Array.from(group.packages.entries()).sort(
        ([a], [b]) => a.localeCompare(b),
      );
      for (const [source, items] of sortedPackages) {
        lines.push(`    ${theme.fg("mdLink", source)}`);
        const sortedPackagePaths = [...items].sort((a, b) =>
          a.path.localeCompare(b.path),
        );
        for (const item of sortedPackagePaths) {
          lines.push(
            theme.fg("dim", `      ${options.formatPackagePath(item, source)}`),
          );
        }
      }
    }

    return lines.join("\n");
  };

InteractiveModeBase.prototype.findSourceInfoForPath = function(this: InteractiveModeBase, p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
    const exact = sourceInfos.get(p);
    if (exact) return exact;

    let current = p;
    while (current.includes("/")) {
      current = current.substring(0, current.lastIndexOf("/"));
      const parent = sourceInfos.get(current);
      if (parent) return parent;
    }

    return undefined;
  };

InteractiveModeBase.prototype.formatPathWithSource = function(this: InteractiveModeBase, p: string, sourceInfo?: SourceInfo): string {
    if (sourceInfo) {
      const shortPath = this.getShortPath(p, sourceInfo);
      const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
      const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
      return `${labelText} ${shortPath}`;
    }
    return this.formatDisplayPath(p);
  };
