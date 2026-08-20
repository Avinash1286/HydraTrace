import analyticsManifest from "../../../fixtures/acme-commerce/analytics-dashboard/hydratrace-deployment.json" with { type: "json" };
import checkoutPackageJson from "../../../fixtures/acme-commerce/checkout-api/package.json" with { type: "json" };
import checkoutLockfile from "../../../fixtures/acme-commerce/checkout-api/package-lock.json" with { type: "json" };
import checkoutManifest from "../../../fixtures/acme-commerce/checkout-api/hydratrace-deployment.json" with { type: "json" };
import paymentPackageJson from "../../../fixtures/acme-commerce/payment-worker/package.json" with { type: "json" };
import paymentLockfile from "../../../fixtures/acme-commerce/payment-worker/package-lock.json" with { type: "json" };
import paymentManifest from "../../../fixtures/acme-commerce/payment-worker/hydratrace-deployment.json" with { type: "json" };
import type { ScanWorkflowInput } from "./services/scans.js";

const analyticsLockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:
  .:
    dependencies:
      chart-core:
        specifier: 1.0.0
        version: 1.0.0
      chart-wrapper:
        specifier: 3.0.0
        version: 3.0.0(chart-core@1.0.0)
    devDependencies:
      dashboard-test-kit:
        specifier: 1.0.0
        version: 1.0.0

packages:
  chart-core@1.0.0:
    resolution:
      integrity: sha512-Y2hhcnQtY29yZS0xLjAuMC1maXh0dXJl
  chart-wrapper@3.0.0:
    resolution:
      integrity: sha512-Y2hhcnQtd3JhcHBlci0zLjAuMC1maXh0dXJl
    peerDependencies:
      chart-core: ^1.0.0
  compromised-helper@1.4.2:
    resolution:
      integrity: sha512-Y29tcHJvbWlzZWQtaGVscGVyLTEuNC4yLWZpeHR1cmU=
  compromised-helper@1.4.3:
    resolution:
      integrity: sha512-Y29tcHJvbWlzZWQtaGVscGVyLTEuNC4zLWZpeHR1cmU=
  dashboard-test-kit@1.0.0:
    resolution:
      integrity: sha512-ZGFzaGJvYXJkLXRlc3Qta2l0LTEuMC4wLWZpeHR1cmU=
  optional-formatter@1.0.0:
    resolution:
      integrity: sha512-b3B0aW9uYWwtZm9ybWF0dGVyLTEuMC4wLWZpeHR1cmU=

snapshots:
  chart-core@1.0.0: {}
  chart-wrapper@3.0.0(chart-core@1.0.0):
    dependencies:
      chart-core: 1.0.0
      compromised-helper: 1.4.3
    optionalDependencies:
      optional-formatter: 1.0.0
  compromised-helper@1.4.2: {}
  compromised-helper@1.4.3: {}
  dashboard-test-kit@1.0.0:
    dependencies:
      compromised-helper: 1.4.2
  optional-formatter@1.0.0:
    optional: true
`;

const timeline = {
  safe: Date.parse("2026-08-15T09:00:00.000Z"),
  checkoutAffected: Date.parse("2026-08-15T09:04:00.000Z"),
  paymentAffected: Date.parse("2026-08-15T09:09:00.000Z"),
  checkoutFixed: Date.parse("2026-08-15T10:20:00.000Z"),
  paymentFixed: Date.parse("2026-08-15T11:42:00.000Z"),
  analyticsFixed: Date.parse("2026-08-15T11:50:00.000Z"),
} as const;

export const DEMO_INCIDENT_START = Date.parse("2026-08-15T09:02:00.000Z");
export const DEMO_INCIDENT_END = Date.parse("2026-08-15T12:00:00.000Z");

export interface BuiltInDemoRemediationArtifact {
  repositoryId: string;
  affectedCommitSha: string;
  fixedCommitSha: string;
  packageJson: string;
  affectedPackageLock: string;
  fixedPackageLock: string;
  expectedAffectedSha256: string;
  expectedFixedSha256: string;
  changes: readonly { dependencyName: string; fromVersion: string; toVersion: string }[];
}

export function builtInDemoScans(): ScanWorkflowInput[] {
  const checkoutAffected = clone(checkoutLockfile);
  const paymentAffected = clone(paymentLockfile);
  const checkoutSafe = replacePackageLockVersion(checkoutAffected, "compromised-helper", "1.4.2", "1.4.1");
  const checkoutFixed = upgradePackageLockVersion(
    upgradePackageLockVersion(
      replacePackageLockVersion(checkoutAffected, "compromised-helper", "1.4.2", "1.4.3"),
      "checkout-framework",
      "2.0.0",
      "2.0.1",
    ),
    "telemetry-core",
    "3.2.0",
    "3.2.1",
  );
  const paymentSafe = replacePackageLockVersion(paymentAffected, "compromised-helper", "1.4.2", "1.4.1");
  const paymentFixed = upgradePackageLockVersion(
    upgradePackageLockVersion(
      replacePackageLockVersion(paymentAffected, "compromised-helper", "1.4.2", "1.4.3"),
      "telemetry-core",
      "3.2.0",
      "3.2.1",
    ),
    "queue-runtime",
    "4.0.0",
    "4.0.1",
  );
  const analyticsFixed = analyticsLockfile.replace(
    "      compromised-helper: 1.4.2",
    "      compromised-helper: 1.4.3",
  );

  return [
    scan(checkoutSafe, manifest(checkoutManifest, {
      commitSha: "0111111111111111111111111111111111111111",
      startedAt: timeline.safe,
      endedAt: timeline.checkoutAffected,
    })),
    scan(checkoutAffected, manifest(checkoutManifest, {
      endedAt: timeline.checkoutFixed,
    })),
    scan(checkoutFixed, manifest(checkoutManifest, {
      commitSha: "4111111111111111111111111111111111111111",
      startedAt: timeline.checkoutFixed,
      endedAt: null,
    })),
    scan(paymentSafe, manifest(paymentManifest, {
      commitSha: "0222222222222222222222222222222222222222",
      startedAt: timeline.safe,
      endedAt: timeline.paymentAffected,
    })),
    scan(paymentAffected, manifest(paymentManifest, {
      endedAt: timeline.paymentFixed,
    })),
    scan(paymentFixed, manifest(paymentManifest, {
      commitSha: "4222222222222222222222222222222222222222",
      startedAt: timeline.paymentFixed,
      endedAt: null,
    })),
    textScan(analyticsLockfile, "pnpm-lock.yaml", manifest(analyticsManifest, {
      endedAt: timeline.analyticsFixed,
    })),
    textScan(analyticsFixed, "pnpm-lock.yaml", manifest(analyticsManifest, {
      commitSha: "4333333333333333333333333333333333333333",
      startedAt: timeline.analyticsFixed,
      endedAt: null,
    })),
  ];
}

export function builtInDemoRemediationArtifacts(): BuiltInDemoRemediationArtifact[] {
  const scans = builtInDemoScans();
  const byCommit = new Map(scans.map((scanInput) => [scanInput.commitSha, scanInput]));
  const checkoutAffected = byCommit.get("1111111111111111111111111111111111111111")!;
  const checkoutFixed = byCommit.get("4111111111111111111111111111111111111111")!;
  const paymentAffected = byCommit.get("2222222222222222222222222222222222222222")!;
  const paymentFixed = byCommit.get("4222222222222222222222222222222222222222")!;
  return [{
    repositoryId: checkoutAffected.repositoryId,
    affectedCommitSha: checkoutAffected.commitSha,
    fixedCommitSha: checkoutFixed.commitSha,
    packageJson: JSON.stringify(checkoutPackageJson, null, 2),
    affectedPackageLock: checkoutAffected.content,
    fixedPackageLock: checkoutFixed.content,
    expectedAffectedSha256: "4eb14cca78f9a38232fb37860fadd3609f9a537cd2346ef9581cae04449cdff1",
    expectedFixedSha256: "bce36466dfc001d75482d647d21d48808558219b6507a825ba5340fb6c29114e",
    changes: [{ dependencyName: "checkout-framework", fromVersion: "2.0.0", toVersion: "2.0.1" }],
  }, {
    repositoryId: paymentAffected.repositoryId,
    affectedCommitSha: paymentAffected.commitSha,
    fixedCommitSha: paymentFixed.commitSha,
    packageJson: JSON.stringify(paymentPackageJson, null, 2),
    affectedPackageLock: paymentAffected.content,
    fixedPackageLock: paymentFixed.content,
    expectedAffectedSha256: "7822e6663146f609ff4936037d181c60cab2c2767dabd364967f14714396d1d4",
    expectedFixedSha256: "b211e0ae7110a7df7c72e11e378905f5627f1b80c0b96fa854505080fa2447b3",
    changes: [
      { dependencyName: "telemetry-core", fromVersion: "3.2.0", toVersion: "3.2.1" },
      { dependencyName: "queue-runtime", fromVersion: "4.0.0", toVersion: "4.0.1" },
    ],
  }];
}

function scan(
  lockfile: Record<string, unknown>,
  deployment: Record<string, unknown>,
): ScanWorkflowInput {
  return {
    content: JSON.stringify(lockfile, null, 2),
    sourceRef: "package-lock.json",
    repositoryId: String(deployment.repositoryId),
    commitSha: String(deployment.commitSha),
    observedAt: Date.parse(String(deployment.startedAt)),
    deploymentManifest: JSON.stringify(deployment),
  };
}

function textScan(
  content: string,
  sourceRef: string,
  deployment: Record<string, unknown>,
): ScanWorkflowInput {
  return {
    content,
    sourceRef,
    repositoryId: String(deployment.repositoryId),
    commitSha: String(deployment.commitSha),
    observedAt: Date.parse(String(deployment.startedAt)),
    deploymentManifest: JSON.stringify(deployment),
  };
}

function manifest(
  source: Record<string, unknown>,
  overrides: { commitSha?: string; startedAt?: number; endedAt: number | null },
): Record<string, unknown> {
  return {
    ...clone(source),
    ...(overrides.commitSha === undefined ? {} : { commitSha: overrides.commitSha }),
    ...(overrides.startedAt === undefined ? {} : { startedAt: new Date(overrides.startedAt).toISOString() }),
    endedAt: overrides.endedAt === null ? null : new Date(overrides.endedAt).toISOString(),
  };
}

function replacePackageLockVersion(
  source: Record<string, unknown>,
  packageName: string,
  from: string,
  to: string,
): Record<string, unknown> {
  const rendered = JSON.stringify(source)
    .replaceAll(`\"${packageName}\":\"${from}\"`, `\"${packageName}\":\"${to}\"`)
    .replaceAll(`\"version\":\"${from}\"`, `\"version\":\"${to}\"`);
  return JSON.parse(rendered) as Record<string, unknown>;
}

function upgradePackageLockVersion(
  source: Record<string, unknown>,
  packageName: string,
  from: string,
  to: string,
): Record<string, unknown> {
  const upgraded = clone(source);
  visit(upgraded);
  return upgraded;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record[packageName] === from) record[packageName] = to;
    if (record.version === from && typeof record.resolved === "string" && record.resolved.includes(`/${packageName}-`)) {
      record.version = to;
      record.resolved = record.resolved.replace(`${packageName}-${from}.tgz`, `${packageName}-${to}.tgz`);
    }
    for (const child of Object.values(record)) visit(child);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
