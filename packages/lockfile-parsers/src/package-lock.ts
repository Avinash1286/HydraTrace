import {
  canonicalKeys,
  normalizeNpmPackageName,
  stableIdFromCanonicalKey,
  type DependencyKind,
  type LockfileParserOptions,
  type NormalizedPackageVersion,
  type NormalizedResolution,
  type NormalizedResolutionEdge,
  type NormalizedSnapshot,
  type ParserWarning,
} from "@hydratrace/domain";
import {
  booleanValue,
  createPackageVersion,
  createParserContext,
  createResolution,
  isRecord,
  optionalString,
  sortByStableId,
} from "./common.js";

type PackageEntry = Record<string, unknown>;

interface DirectDependencyFlags {
  production: Set<string>;
  development: Set<string>;
  optional: Set<string>;
  peer: Set<string>;
}

export function parsePackageLock(
  rawContent: string,
  options: LockfileParserOptions,
): NormalizedSnapshot {
  let document: unknown;
  try {
    document = JSON.parse(rawContent) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid package-lock JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(document)) {
    throw new Error("package-lock.json must contain a JSON object");
  }
  if (document.lockfileVersion !== 2 && document.lockfileVersion !== 3) {
    throw new Error("Only package-lock.json lockfileVersion 2 and 3 are supported");
  }
  if (!isRecord(document.packages)) {
    throw new Error('package-lock.json must contain a "packages" map');
  }

  const context = createParserContext(rawContent, "package-lock", options);
  const warnings: ParserWarning[] = [];
  const packageVersions = new Map<string, NormalizedPackageVersion>();
  const resolutionsByPath = new Map<string, NormalizedResolution>();
  const directFlags = collectDirectDependencyFlags(document.packages[""]);

  for (const [uncheckedInstallPath, value] of Object.entries(document.packages)) {
    const installPath = normalizeInstallPath(uncheckedInstallPath);
    if (!isRecord(value)) {
      warnings.push({
        code: "INVALID_ENTRY",
        message: `Package entry ${installPath} is not an object`,
        sourceKey: installPath,
      });
      continue;
    }

    const version = optionalString(value.version);
    const name = optionalString(value.name) ?? derivePackageNameFromInstallPath(installPath);
    if (name === undefined || version === undefined) {
      warnings.push({
        code: booleanValue(value.link) ? "UNSUPPORTED_LINK" : "MISSING_VERSION",
        message: `Package entry ${installPath} has no exact package name/version`,
        sourceKey: installPath,
      });
      continue;
    }

    const normalizedName = normalizeNpmPackageName(name);
    const integrity = optionalString(value.integrity);
    const resolved = optionalString(value.resolved);
    const packageVersion = createPackageVersion({
      name,
      version,
      provenance: context.provenance,
      ...(integrity === undefined ? {} : { integrity }),
      ...(resolved === undefined ? {} : { resolved }),
    });
    const previousVersion = packageVersions.get(packageVersion.id);
    packageVersions.set(packageVersion.id, mergePackageVersion(previousVersion, packageVersion));

    const resolution = createResolution({
      snapshotId: context.snapshotId,
      packageVersionId: packageVersion.id,
      packageName: name,
      version,
      sourceKey: installPath,
      installPath,
      root: installPath === "",
      direct: installPath !== "" && isDirect(normalizedName, directFlags),
      dev:
        booleanValue(value.dev) ||
        (directFlags.development.has(normalizedName) &&
          !directFlags.production.has(normalizedName)),
      optional: booleanValue(value.optional) || directFlags.optional.has(normalizedName),
      peer: booleanValue(value.peer) || directFlags.peer.has(normalizedName),
      provenance: context.provenance,
      ...(integrity === undefined ? {} : { integrity }),
      ...(resolved === undefined ? {} : { resolved }),
    });
    resolutionsByPath.set(installPath, resolution);
  }

  const edges = createDependencyEdges({
    packageEntries: document.packages,
    resolutionsByPath,
    snapshotId: context.snapshotId,
    provenance: context.provenance,
    warnings,
  });

  return {
    snapshot: {
      id: context.snapshotId,
      ecosystem: "npm",
      lockfileType: "package-lock",
      contentHash: context.contentHash,
      repositoryId: context.options.repositoryId,
      commitSha: context.options.commitSha,
      sourceRef: context.options.sourceRef,
      parserVersion: context.provenance.parserVersion,
      createdAt: context.options.observedAt,
    },
    packages: sortByStableId([...packageVersions.values()]),
    resolutions: sortByStableId([...resolutionsByPath.values()]),
    edges: sortByStableId(edges),
    warnings,
  };
}

function createDependencyEdges(input: {
  packageEntries: Record<string, unknown>;
  resolutionsByPath: Map<string, NormalizedResolution>;
  snapshotId: NormalizedSnapshot["snapshot"]["id"];
  provenance: NormalizedResolution["provenance"];
  warnings: ParserWarning[];
}): NormalizedResolutionEdge[] {
  const edges = new Map<string, NormalizedResolutionEdge>();

  for (const [rawPath, value] of Object.entries(input.packageEntries)) {
    if (!isRecord(value)) continue;
    const installPath = normalizeInstallPath(rawPath);
    const from = input.resolutionsByPath.get(installPath);
    if (from === undefined) continue;

    const dependencies = collectDeclaredDependencies(value);
    for (const [dependencyName, declaration] of dependencies) {
      const targetPath = resolveInstalledDependencyPath(
        installPath,
        dependencyName,
        input.resolutionsByPath,
      );
      if (targetPath === undefined) {
        input.warnings.push({
          code: "UNRESOLVED_DEPENDENCY",
          message: `Could not map ${dependencyName} declared by ${installPath} to an installed package instance`,
          sourceKey: installPath,
          dependencyName,
        });
        continue;
      }

      const to = input.resolutionsByPath.get(targetPath);
      if (to === undefined) continue;
      const id = stableIdFromCanonicalKey(
        canonicalKeys.resolutionEdge(input.snapshotId, from.id, to.id, dependencyName),
      );
      edges.set(id, {
        id,
        snapshotId: input.snapshotId,
        fromResolutionId: from.id,
        toResolutionId: to.id,
        dependencyName,
        specifier: declaration.specifier,
        kind: declaration.kind,
        provenance: input.provenance,
      });
    }
  }

  return [...edges.values()];
}

function collectDeclaredDependencies(
  entry: PackageEntry,
): Map<string, { specifier: string; kind: DependencyKind }> {
  const result = new Map<string, { specifier: string; kind: DependencyKind }>();
  addDependencyMap(result, entry.dependencies, "production");
  addDependencyMap(result, entry.devDependencies, "development");
  addDependencyMap(result, entry.peerDependencies, "peer");
  addDependencyMap(result, entry.optionalDependencies, "optional");
  return result;
}

function addDependencyMap(
  output: Map<string, { specifier: string; kind: DependencyKind }>,
  value: unknown,
  kind: DependencyKind,
): void {
  if (!isRecord(value)) return;
  for (const [name, specifier] of Object.entries(value)) {
    if (typeof specifier === "string") {
      output.set(normalizeNpmPackageName(name), { specifier, kind });
    }
  }
}

function collectDirectDependencyFlags(root: unknown): DirectDependencyFlags {
  const flags: DirectDependencyFlags = {
    production: new Set(),
    development: new Set(),
    optional: new Set(),
    peer: new Set(),
  };
  if (!isRecord(root)) return flags;
  addNames(flags.production, root.dependencies);
  addNames(flags.development, root.devDependencies);
  addNames(flags.optional, root.optionalDependencies);
  addNames(flags.peer, root.peerDependencies);
  return flags;
}

function addNames(output: Set<string>, value: unknown): void {
  if (!isRecord(value)) return;
  for (const name of Object.keys(value)) output.add(normalizeNpmPackageName(name));
}

function isDirect(name: string, flags: DirectDependencyFlags): boolean {
  return (
    flags.production.has(name) ||
    flags.development.has(name) ||
    flags.optional.has(name) ||
    flags.peer.has(name)
  );
}

function mergePackageVersion(
  previous: NormalizedPackageVersion | undefined,
  current: NormalizedPackageVersion,
): NormalizedPackageVersion {
  if (previous === undefined) return current;
  return {
    ...previous,
    ...(previous.integrity === undefined && current.integrity !== undefined
      ? { integrity: current.integrity }
      : {}),
    ...(previous.resolved === undefined && current.resolved !== undefined
      ? { resolved: current.resolved }
      : {}),
  };
}

export function derivePackageNameFromInstallPath(installPath: string): string | undefined {
  const normalized = normalizeInstallPath(installPath);
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const tail = normalized.slice(markerIndex + marker.length);
  const parts = tail.split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts[0]?.startsWith("@") && parts[1] !== undefined
    ? `${parts[0]}/${parts[1]}`
    : parts[0];
}

export function resolveInstalledDependencyPath(
  fromInstallPath: string,
  dependencyName: string,
  installed: ReadonlyMap<string, unknown>,
): string | undefined {
  const normalizedDependency = normalizeNpmPackageName(dependencyName);
  let cursor = normalizeInstallPath(fromInstallPath);

  while (true) {
    const candidate = cursor
      ? `${cursor}/node_modules/${normalizedDependency}`
      : `node_modules/${normalizedDependency}`;
    if (installed.has(candidate)) return candidate;
    const nestedMarker = cursor.lastIndexOf("/node_modules/");
    if (nestedMarker < 0) {
      if (cursor === "") return undefined;
      cursor = "";
    } else {
      cursor = cursor.slice(0, nestedMarker);
    }
  }
}

function normalizeInstallPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}
