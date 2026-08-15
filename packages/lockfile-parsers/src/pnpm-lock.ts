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
  type StableId,
} from "@hydratrace/domain";
import { parse as parseYaml } from "yaml";
import {
  booleanValue,
  createPackageVersion,
  createParserContext,
  createResolution,
  isRecord,
  optionalString,
  sortByStableId,
} from "./common.js";

interface DependencyDeclaration {
  name: string;
  reference: string;
  specifier?: string;
  kind: DependencyKind;
}

interface PnpmLocator {
  name: string;
  version: string;
  baseKey: string;
  hasPeerContext: boolean;
}

export function parsePnpmLock(
  rawContent: string,
  options: LockfileParserOptions,
): NormalizedSnapshot {
  let document: unknown;
  try {
    document = parseYaml(rawContent) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid pnpm lockfile YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(document)) throw new Error("pnpm-lock.yaml must contain a YAML mapping");

  const lockfileVersion = String(document.lockfileVersion ?? "");
  if (!/^(?:6|7|8|9)(?:\.\d+)?$/.test(lockfileVersion)) {
    throw new Error(`Unsupported pnpm lockfileVersion: ${lockfileVersion || "missing"}`);
  }
  if (!isRecord(document.importers)) {
    throw new Error('pnpm-lock.yaml must contain an "importers" map');
  }

  const context = createParserContext(rawContent, "pnpm-lock", options);
  const warnings: ParserWarning[] = [];
  const packagesMetadata = isRecord(document.packages) ? document.packages : {};
  const snapshots = isRecord(document.snapshots) ? document.snapshots : packagesMetadata;
  const packageVersions = new Map<string, NormalizedPackageVersion>();
  const resolutionsBySourceKey = new Map<string, NormalizedResolution>();
  const locatorsBySourceKey = new Map<string, PnpmLocator>();

  for (const [rawSourceKey, rawEntry] of Object.entries(snapshots)) {
    const sourceKey = normalizePnpmSourceKey(rawSourceKey);
    const locator = parsePnpmLocator(sourceKey);
    if (locator === undefined) {
      warnings.push({
        code: "INVALID_ENTRY",
        message: `Could not determine an exact package name/version from pnpm key ${rawSourceKey}`,
        sourceKey: rawSourceKey,
      });
      continue;
    }

    const baseMetadata = packagesMetadata[locator.baseKey];
    const rawMetadata = packagesMetadata[rawSourceKey];
    const metadata: Record<string, unknown> = isRecord(baseMetadata)
      ? baseMetadata
      : isRecord(rawMetadata)
        ? rawMetadata
        : {};
    const resolutionMetadata = isRecord(metadata.resolution) ? metadata.resolution : {};
    const snapshotEntry = isRecord(rawEntry) ? rawEntry : {};
    const integrity = optionalString(resolutionMetadata.integrity);
    const resolved = optionalString(resolutionMetadata.tarball);
    const packageVersion = createPackageVersion({
      name: locator.name,
      version: locator.version,
      provenance: context.provenance,
      ...(integrity === undefined ? {} : { integrity }),
      ...(resolved === undefined ? {} : { resolved }),
    });
    packageVersions.set(
      packageVersion.id,
      mergePackageVersion(packageVersions.get(packageVersion.id), packageVersion),
    );
    const resolution = createResolution({
      snapshotId: context.snapshotId,
      packageVersionId: packageVersion.id,
      packageName: locator.name,
      version: locator.version,
      sourceKey,
      installPath: pnpmVirtualInstallPath(sourceKey, locator.name),
      root: false,
      direct: false,
      dev: false,
      optional: booleanValue(snapshotEntry.optional) || booleanValue(metadata.optional),
      peer: locator.hasPeerContext,
      provenance: context.provenance,
      ...(integrity === undefined ? {} : { integrity }),
      ...(resolved === undefined ? {} : { resolved }),
    });
    resolutionsBySourceKey.set(sourceKey, resolution);
    locatorsBySourceKey.set(sourceKey, locator);
  }

  const rootImporterKey = selectRootImporterKey(document.importers);
  const rootImporter = isRecord(document.importers[rootImporterKey])
    ? document.importers[rootImporterKey]
    : {};
  const rootPackage =
    context.options.rootPackage ?? syntheticRootPackage(context.options.repositoryId);
  const rootVersion = createPackageVersion({
    name: rootPackage.name,
    version: rootPackage.version,
    provenance: context.provenance,
  });
  packageVersions.set(rootVersion.id, rootVersion);
  const rootResolution = createResolution({
    snapshotId: context.snapshotId,
    packageVersionId: rootVersion.id,
    packageName: rootPackage.name,
    version: rootPackage.version,
    sourceKey: rootImporterKey,
    installPath: rootImporterKey,
    root: true,
    direct: false,
    dev: false,
    optional: false,
    peer: false,
    provenance: context.provenance,
  });
  resolutionsBySourceKey.set(rootImporterKey, rootResolution);

  const rootDeclarations = collectDependencyDeclarations(rootImporter, false);
  materializeWorkspaceReferences({
    declarations: rootDeclarations,
    context,
    packageVersions,
    resolutionsBySourceKey,
  });

  const edges = new Map<string, NormalizedResolutionEdge>();
  const productionSeeds = new Set<StableId>();
  const developmentSeeds = new Set<StableId>();
  addPnpmEdges({
    from: rootResolution,
    declarations: rootDeclarations,
    snapshotId: context.snapshotId,
    provenance: context.provenance,
    resolutionsBySourceKey,
    warnings,
    edges,
    productionSeeds,
    developmentSeeds,
  });

  for (const [sourceKey, rawEntry] of Object.entries(snapshots)) {
    const normalizedSourceKey = normalizePnpmSourceKey(sourceKey);
    const from = resolutionsBySourceKey.get(normalizedSourceKey);
    if (from === undefined || !isRecord(rawEntry)) continue;
    const locator = locatorsBySourceKey.get(normalizedSourceKey);
    const metadata = locator === undefined ? {} : packagesMetadata[locator.baseKey];
    const peerNames = isRecord(metadata) && isRecord(metadata.peerDependencies)
      ? new Set(Object.keys(metadata.peerDependencies).map(normalizeNpmPackageName))
      : new Set<string>();
    const declarations = collectDependencyDeclarations(rawEntry, false).map((declaration) =>
      peerNames.has(normalizeNpmPackageName(declaration.name))
        ? { ...declaration, kind: "peer" as const }
        : declaration,
    );
    addPnpmEdges({
      from,
      declarations,
      snapshotId: context.snapshotId,
      provenance: context.provenance,
      resolutionsBySourceKey,
      warnings,
      edges,
    });
  }

  const resolutions = [...resolutionsBySourceKey.values()];
  markDirectAndReachabilityFlags({
    rootResolution,
    resolutions,
    edges: [...edges.values()],
    productionSeeds,
    developmentSeeds,
  });

  return {
    snapshot: {
      id: context.snapshotId,
      ecosystem: "npm",
      lockfileType: "pnpm-lock",
      contentHash: context.contentHash,
      repositoryId: context.options.repositoryId,
      commitSha: context.options.commitSha,
      sourceRef: context.options.sourceRef,
      parserVersion: context.provenance.parserVersion,
      createdAt: context.options.observedAt,
    },
    packages: sortByStableId([...packageVersions.values()]),
    resolutions: sortByStableId(resolutions),
    edges: sortByStableId([...edges.values()]),
    warnings,
  };
}

function addPnpmEdges(input: {
  from: NormalizedResolution;
  declarations: DependencyDeclaration[];
  snapshotId: StableId;
  provenance: NormalizedResolution["provenance"];
  resolutionsBySourceKey: Map<string, NormalizedResolution>;
  warnings: ParserWarning[];
  edges: Map<string, NormalizedResolutionEdge>;
  productionSeeds?: Set<StableId>;
  developmentSeeds?: Set<StableId>;
}): void {
  for (const declaration of input.declarations) {
    const target = resolvePnpmDependency(
      declaration.name,
      declaration.reference,
      input.resolutionsBySourceKey,
    );
    if (target === undefined) {
      input.warnings.push({
        code: "UNRESOLVED_DEPENDENCY",
        message: `Could not map ${declaration.name}@${declaration.reference} from ${input.from.sourceKey}`,
        sourceKey: input.from.sourceKey,
        dependencyName: declaration.name,
      });
      continue;
    }

    const edgeId = stableIdFromCanonicalKey(
      canonicalKeys.resolutionEdge(input.snapshotId, input.from.id, target.id, declaration.name),
    );
    input.edges.set(edgeId, {
      id: edgeId,
      snapshotId: input.snapshotId,
      fromResolutionId: input.from.id,
      toResolutionId: target.id,
      dependencyName: normalizeNpmPackageName(declaration.name),
      specifier: declaration.specifier ?? declaration.reference,
      kind: declaration.kind,
      provenance: input.provenance,
    });

    if (input.from.root) {
      if (declaration.kind === "development") input.developmentSeeds?.add(target.id);
      else input.productionSeeds?.add(target.id);
      target.direct = true;
      if (declaration.kind === "optional") target.optional = true;
      if (declaration.kind === "peer") target.peer = true;
    }
  }
}

function collectDependencyDeclarations(
  value: Record<string, unknown>,
  parentIsDev: boolean,
): DependencyDeclaration[] {
  const declarations = new Map<string, DependencyDeclaration>();
  collectFromSection(
    declarations,
    value.dependencies,
    parentIsDev ? "development" : "production",
  );
  collectFromSection(declarations, value.peerDependencies, "peer");
  collectFromSection(declarations, value.optionalDependencies, "optional");
  collectFromSection(declarations, value.devDependencies, "development");
  return [...declarations.values()];
}

function collectFromSection(
  output: Map<string, DependencyDeclaration>,
  section: unknown,
  kind: DependencyKind,
): void {
  if (!isRecord(section)) return;
  for (const [name, rawDeclaration] of Object.entries(section)) {
    const normalizedName = normalizeNpmPackageName(name);
    if (typeof rawDeclaration === "string") {
      output.set(normalizedName, {
        name: normalizedName,
        reference: rawDeclaration,
        kind,
      });
      continue;
    }
    if (!isRecord(rawDeclaration)) continue;
    const reference = optionalString(rawDeclaration.version);
    if (reference === undefined) continue;
    const specifier = optionalString(rawDeclaration.specifier);
    output.set(normalizedName, {
      name: normalizedName,
      reference,
      ...(specifier === undefined ? {} : { specifier }),
      kind,
    });
  }
}

function resolvePnpmDependency(
  dependencyName: string,
  rawReference: string,
  resolutions: ReadonlyMap<string, NormalizedResolution>,
): NormalizedResolution | undefined {
  const workspaceKey = workspaceResolutionKey(dependencyName, rawReference);
  if (workspaceKey !== undefined) return resolutions.get(workspaceKey);

  let reference = rawReference;
  if (reference.startsWith("npm:")) {
    const aliasLocator = parsePnpmLocator(reference.slice(4));
    if (aliasLocator !== undefined) {
      const exactAlias = resolutions.get(aliasLocator.baseKey);
      if (exactAlias !== undefined) return exactAlias;
    }
    reference = reference.slice(4);
  }
  const exactKey = normalizePnpmSourceKey(`${normalizeNpmPackageName(dependencyName)}@${reference}`);
  const exact = resolutions.get(exactKey);
  if (exact !== undefined) return exact;

  const baseKey = stripPeerContext(exactKey);
  const candidates = [...resolutions.entries()]
    .filter(([sourceKey]) => stripPeerContext(sourceKey) === baseKey)
    .sort(([left], [right]) => left.localeCompare(right));
  return candidates[0]?.[1];
}

function materializeWorkspaceReferences(input: {
  declarations: DependencyDeclaration[];
  context: ReturnType<typeof createParserContext>;
  packageVersions: Map<string, NormalizedPackageVersion>;
  resolutionsBySourceKey: Map<string, NormalizedResolution>;
}): void {
  for (const declaration of input.declarations) {
    const sourceKey = workspaceResolutionKey(declaration.name, declaration.reference);
    if (sourceKey === undefined || input.resolutionsBySourceKey.has(sourceKey)) continue;
    const version = `workspace:${declaration.reference}`;
    const packageVersion = createPackageVersion({
      name: declaration.name,
      version,
      provenance: input.context.provenance,
    });
    input.packageVersions.set(packageVersion.id, packageVersion);
    input.resolutionsBySourceKey.set(
      sourceKey,
      createResolution({
        snapshotId: input.context.snapshotId,
        packageVersionId: packageVersion.id,
        packageName: declaration.name,
        version,
        sourceKey,
        installPath: declaration.reference,
        root: false,
        direct: true,
        dev: declaration.kind === "development",
        optional: declaration.kind === "optional",
        peer: declaration.kind === "peer",
        provenance: input.context.provenance,
      }),
    );
  }
}

function markDirectAndReachabilityFlags(input: {
  rootResolution: NormalizedResolution;
  resolutions: NormalizedResolution[];
  edges: NormalizedResolutionEdge[];
  productionSeeds: Set<StableId>;
  developmentSeeds: Set<StableId>;
}): void {
  const adjacency = new Map<StableId, StableId[]>();
  for (const edge of input.edges) {
    const targets = adjacency.get(edge.fromResolutionId) ?? [];
    targets.push(edge.toResolutionId);
    adjacency.set(edge.fromResolutionId, targets);
  }
  const productionReachable = closure(input.productionSeeds, adjacency);
  const developmentReachable = closure(input.developmentSeeds, adjacency);

  for (const resolution of input.resolutions) {
    if (resolution.id === input.rootResolution.id) continue;
    resolution.dev =
      developmentReachable.has(resolution.id) && !productionReachable.has(resolution.id);
  }
}

function closure(seeds: ReadonlySet<StableId>, adjacency: Map<StableId, StableId[]>): Set<StableId> {
  const seen = new Set<StableId>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return seen;
}

export function parsePnpmLocator(rawKey: string): PnpmLocator | undefined {
  const sourceKey = normalizePnpmSourceKey(rawKey);
  const baseKey = stripPeerContext(sourceKey);

  if (baseKey.startsWith("/")) {
    const segments = baseKey.slice(1).split("/");
    if (segments[0]?.startsWith("@") && segments.length >= 3) {
      return {
        name: `${segments[0]}/${segments[1]}`,
        version: segments.slice(2).join("/"),
        baseKey,
        hasPeerContext: sourceKey !== baseKey,
      };
    }
    if (segments.length >= 2 && segments[0] !== undefined) {
      return {
        name: segments[0],
        version: segments.slice(1).join("/"),
        baseKey,
        hasPeerContext: sourceKey !== baseKey,
      };
    }
  }

  const separator = baseKey.lastIndexOf("@");
  if (separator <= 0 || separator === baseKey.length - 1) return undefined;
  return {
    name: baseKey.slice(0, separator),
    version: baseKey.slice(separator + 1),
    baseKey,
    hasPeerContext: sourceKey !== baseKey,
  };
}

function stripPeerContext(sourceKey: string): string {
  const peerStart = sourceKey.indexOf("(");
  return peerStart < 0 ? sourceKey : sourceKey.slice(0, peerStart);
}

function normalizePnpmSourceKey(sourceKey: string): string {
  return sourceKey.replaceAll("\\", "/");
}

function pnpmVirtualInstallPath(sourceKey: string, packageName: string): string {
  const encoded = sourceKey.replaceAll("/", "+").replaceAll("(", "_").replaceAll(")", "_");
  return `node_modules/.pnpm/${encoded}/node_modules/${packageName}`;
}

function selectRootImporterKey(importers: Record<string, unknown>): string {
  if (Object.hasOwn(importers, ".")) return ".";
  const first = Object.keys(importers).sort()[0];
  if (first === undefined) throw new Error("pnpm-lock.yaml contains no importers");
  return first;
}

function workspaceResolutionKey(name: string, reference: string): string | undefined {
  return /^(?:link:|workspace:|file:)/.test(reference)
    ? `workspace:${normalizeNpmPackageName(name)}:${reference}`
    : undefined;
}

function syntheticRootPackage(repositoryId: string): { name: string; version: string } {
  const suffix = stableIdFromCanonicalKey(`root-package:${repositoryId}`).slice(0, 10);
  return { name: `@hydratrace/root-${suffix}`, version: "0.0.0" };
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
