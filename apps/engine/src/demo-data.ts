import analyticsManifest from "../../../fixtures/acme-commerce/analytics-dashboard/hydratrace-deployment.json" with { type: "json" };
import checkoutLockfile from "../../../fixtures/acme-commerce/checkout-api/package-lock.json" with { type: "json" };
import checkoutManifest from "../../../fixtures/acme-commerce/checkout-api/hydratrace-deployment.json" with { type: "json" };
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
} as const;

export const DEMO_INCIDENT_START = Date.parse("2026-08-15T09:02:00.000Z");
export const DEMO_INCIDENT_END = Date.parse("2026-08-15T12:00:00.000Z");

export function builtInDemoScans(): ScanWorkflowInput[] {
  const checkoutAffected = clone(checkoutLockfile);
  const paymentAffected = clone(paymentLockfile);
  const checkoutSafe = replacePackageLockVersion(checkoutAffected, "compromised-helper", "1.4.2", "1.4.1");
  const checkoutFixed = replacePackageLockVersion(checkoutAffected, "compromised-helper", "1.4.2", "1.4.3");
  const paymentSafe = replacePackageLockVersion(paymentAffected, "compromised-helper", "1.4.2", "1.4.1");
  const paymentFixed = replacePackageLockVersion(paymentAffected, "compromised-helper", "1.4.2", "1.4.3");

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
    {
      content: analyticsLockfile,
      sourceRef: "pnpm-lock.yaml",
      repositoryId: analyticsManifest.repositoryId,
      commitSha: analyticsManifest.commitSha,
      observedAt: Date.parse(analyticsManifest.startedAt),
      deploymentManifest: JSON.stringify(analyticsManifest),
    },
  ];
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

function clone<T>(value: T): T {
  return structuredClone(value);
}
