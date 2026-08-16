import { stableIdFromCanonicalKey } from "@hydratrace/domain";
import ts from "typescript";
import type {
  StaticAnalysisInput,
  StaticAnalysisResult,
  StaticPackageObservation,
} from "./models.js";

interface ImportReference {
  specifier?: string;
  expression?: string;
}

export function analyzeStaticImports(input: StaticAnalysisInput): StaticAnalysisResult {
  if (input.entrypoints.length === 0) throw new Error("At least one entrypoint is required");
  const files = new Map<string, { path: string; source: string }>(
    input.files.map((file) => [normalizePath(file.path), { ...file, path: normalizePath(file.path) }]),
  );
  const pending = input.entrypoints.map(normalizePath);
  const visited = new Set<string>();
  const packages = new Map<string, { importers: Set<string>; specifiers: Set<string>; refs: Set<string> }>();
  const unknownExpressions: Array<{ file: string; expression: string; evidenceRef: string }> = [];
  const moduleEdges: Array<{ from: string; to: string }> = [];

  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined || visited.has(path)) continue;
    const file = resolveKnownFile(path, files);
    if (file === undefined) throw new Error(`Entrypoint or imported source file ${path} was not supplied`);
    if (visited.has(file.path)) continue;
    visited.add(file.path);
    for (const reference of extractImports(file.source, file.path)) {
      if (reference.expression !== undefined) {
        const evidenceRef = staticEvidenceRef(input.commitSha, file.path, reference.expression);
        unknownExpressions.push({ file: file.path, expression: reference.expression, evidenceRef });
        continue;
      }
      const specifier = reference.specifier;
      if (specifier === undefined || isNodeBuiltin(specifier)) continue;
      if (isRelativeSpecifier(specifier)) {
        const resolved = resolveRelative(file.path, specifier, files);
        if (resolved !== undefined) {
          moduleEdges.push({ from: file.path, to: resolved });
          if (!visited.has(resolved)) pending.push(resolved);
        }
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      const observation = packages.get(packageName) ?? {
        importers: new Set<string>(),
        specifiers: new Set<string>(),
        refs: new Set<string>(),
      };
      observation.importers.add(file.path);
      observation.specifiers.add(specifier);
      observation.refs.add(staticEvidenceRef(input.commitSha, file.path, specifier));
      packages.set(packageName, observation);
    }
  }

  const publicPackages: StaticPackageObservation[] = [...packages.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, observation]) => ({
      packageName,
      importers: [...observation.importers].sort(),
      specifiers: [...observation.specifiers].sort(),
      evidenceRefs: [...observation.refs].sort(),
    }));
  return {
    repositoryId: input.repositoryId,
    commitSha: input.commitSha,
    analyzedFiles: [...visited].sort(),
    entrypoints: input.entrypoints.map(normalizePath).sort(),
    moduleEdges: [...new Map(moduleEdges.map((edge) => [`${edge.from}\0${edge.to}`, edge])).values()]
      .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
    unreachableFiles: [...files.keys()].filter((path) => !visited.has(path)).sort(),
    packages: publicPackages,
    unknownDynamicBehavior: unknownExpressions.length > 0,
    unknownExpressions: unknownExpressions.sort(
      (left, right) => left.file.localeCompare(right.file) || left.expression.localeCompare(right.expression),
    ),
  };
}

function extractImports(source: string, path: string): ImportReference[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const references: ImportReference[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) references.push({ specifier: node.moduleSpecifier.text });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression !== undefined && ts.isStringLiteralLike(expression)) references.push({ specifier: expression.text });
    } else if (ts.isCallExpression(node) && isModuleLoadingCall(node.expression)) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) references.push({ specifier: argument.text });
      else references.push({ expression: argument?.getText(sourceFile) ?? "<missing>" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function isModuleLoadingCall(expression: ts.Expression): boolean {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(expression) && expression.text === "require") return true;
  return ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" && expression.name.text === "resolve";
}

function resolveRelative(importer: string, specifier: string, files: ReadonlyMap<string, { path: string; source: string }>): string | undefined {
  const base = normalizePath(`${importer.slice(0, Math.max(0, importer.lastIndexOf("/")))}/${specifier}`);
  return resolveKnownFile(base, files)?.path;
}

function resolveKnownFile(path: string, files: ReadonlyMap<string, { path: string; source: string }>): { path: string; source: string } | undefined {
  const withoutJavaScriptExtension = path.replace(/\.(?:mjs|cjs|js|jsx)$/u, "");
  const candidates = [path, `${path}.ts`, `${path}.tsx`, `${path}.js`, `${path}.jsx`, `${withoutJavaScriptExtension}.ts`, `${withoutJavaScriptExtension}.tsx`, `${path}/index.ts`, `${path}/index.tsx`, `${path}/index.js`];
  for (const candidate of candidates) {
    const file = files.get(normalizePath(candidate));
    if (file !== undefined) return file;
  }
  return undefined;
}

function normalizePath(value: string): string {
  const output: string[] = [];
  for (const token of value.replaceAll("\\", "/").split("/")) {
    if (token === "" || token === ".") continue;
    if (token === "..") output.pop(); else output.push(token);
  }
  return output.join("/");
}

function isRelativeSpecifier(value: string): boolean { return value.startsWith("./") || value.startsWith("../") || value.startsWith("/"); }
function isNodeBuiltin(value: string): boolean { return value.startsWith("node:") || ["fs", "path", "url", "module", "crypto", "http", "https", "stream", "events", "util"].includes(value.split("/")[0] ?? value); }
function packageNameFromSpecifier(value: string): string { const parts = value.split("/"); return value.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? value); }
function staticEvidenceRef(commitSha: string, file: string, value: string): string { return `E-STATIC-${stableIdFromCanonicalKey(`static:${commitSha}:${file}:${value}`)}`; }
