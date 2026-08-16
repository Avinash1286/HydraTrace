import { stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import type { IncidentCatalog } from "./catalog.js";
import { analyzeBlastRadius } from "./blast-radius.js";
import type {
  ExposureTimeline,
  TimelineEvent,
  TimelineEventType,
} from "./models.js";

interface PendingEvent {
  type: TimelineEventType;
  at: number;
  serviceId?: string;
  deploymentId?: StableId;
  snapshotId?: StableId;
  affectedVersion?: string;
  evidenceRefs: readonly string[];
}

export function buildExposureTimeline(
  catalog: IncidentCatalog,
  incidentId: StableId,
): ExposureTimeline {
  const incident = catalog.getIncident(incidentId);
  if (incident === undefined) throw new Error(`Incident ${incidentId} was not found`);
  const full = analyzeBlastRadius(catalog, incidentId, {
    // Timeline defaults to the same production truth as blast radius. A
    // development-only path must not keep the production exposure counter open.
    includeDevelopment: false,
    limit: 100,
  });
  const pending: PendingEvent[] = [];

  if (incident.packagePublishedAt !== undefined) {
    pending.push({
      type: "PACKAGE_VERSION_PUBLISHED",
      at: incident.packagePublishedAt,
      affectedVersion: incident.affectedVersions[0]!,
      evidenceRefs: [`E-PACKAGE-PUBLISHED-${incident.normalizedPackageName}`],
    });
  }
  if (incident.advisoryPublishedAt !== undefined) {
    pending.push({
      type: "ADVISORY_PUBLISHED",
      at: incident.advisoryPublishedAt,
      evidenceRefs: [`E-ADVISORY-${incident.advisoryId ?? incident.id}`],
    });
  }
  if (incident.advisoryWithdrawnAt !== undefined) {
    pending.push({
      type: "ADVISORY_WITHDRAWN",
      at: incident.advisoryWithdrawnAt,
      evidenceRefs: [`E-ADVISORY-${incident.advisoryId ?? incident.id}`],
    });
  }

  if (incident.startsAt !== undefined) {
    pending.push({
      type: "INCIDENT_STARTED",
      at: incident.startsAt,
      evidenceRefs: [`E-INCIDENT-${incident.id}`],
    });
  }
  if (incident.endsAt !== undefined) {
    pending.push({
      type: "INCIDENT_ENDED",
      at: incident.endsAt,
      evidenceRefs: [`E-INCIDENT-${incident.id}`],
    });
  }

  const entriesBySnapshot = new Map(
    catalog.entries().map((entry) => [entry.normalized.snapshot.id, entry]),
  );
  for (const finding of full.findings) {
    const entry = entriesBySnapshot.get(finding.snapshotId);
    const deployment = entry?.deployments.find(
      ({ deploymentId }) => deploymentId === finding.deploymentId,
    );
    if (entry === undefined || deployment === undefined) continue;
    pending.push(
      {
        type: "SNAPSHOT_CREATED",
        at: entry.normalized.snapshot.createdAt,
        snapshotId: finding.snapshotId,
        affectedVersion: finding.affectedVersion,
        evidenceRefs: [`E-SNAPSHOT-${finding.snapshotId}`],
      },
      {
        type: "DEPLOYMENT_STARTED",
        at: deployment.startedAt,
        serviceId: finding.serviceId,
        deploymentId: finding.deploymentId,
        snapshotId: finding.snapshotId,
        affectedVersion: finding.affectedVersion,
        evidenceRefs: [`E-DEPLOYMENT-${finding.deploymentId}`],
      },
      {
        type: "EXPOSURE_STARTED",
        at: finding.firstExposedAt,
        serviceId: finding.serviceId,
        deploymentId: finding.deploymentId,
        snapshotId: finding.snapshotId,
        affectedVersion: finding.affectedVersion,
        evidenceRefs: finding.evidenceRefs,
      },
    );
    if (deployment.endedAt !== null) {
      pending.push({
        type: "DEPLOYMENT_ENDED",
        at: deployment.endedAt,
        serviceId: finding.serviceId,
        deploymentId: finding.deploymentId,
        snapshotId: finding.snapshotId,
        affectedVersion: finding.affectedVersion,
        evidenceRefs: [`E-DEPLOYMENT-${finding.deploymentId}`],
      });
    }
    if (finding.lastExposedAt !== null) {
      pending.push({
        type: "EXPOSURE_ENDED",
        at: finding.lastExposedAt,
        serviceId: finding.serviceId,
        deploymentId: finding.deploymentId,
        snapshotId: finding.snapshotId,
        affectedVersion: finding.affectedVersion,
        evidenceRefs: finding.evidenceRefs,
      });
    }
    for (const evidence of finding.reachabilityEvidence) {
      pending.push({
        type: evidence.source === "static"
          ? "STATIC_REACHABILITY_DETECTED"
          : "RUNTIME_OBSERVATION_RECORDED",
        at: evidence.observedAt,
        serviceId: finding.serviceId,
        deploymentId: finding.deploymentId,
        snapshotId: finding.snapshotId,
        affectedVersion: finding.affectedVersion,
        evidenceRefs: evidence.evidenceRefs,
      });
    }

    if (finding.lastExposedAt !== null) {
      const fixed = catalog.entries()
        .flatMap((candidate) => candidate.deployments.map((candidateDeployment) => ({ candidate, candidateDeployment })))
        .filter(({ candidate, candidateDeployment }) =>
          candidate.normalized.snapshot.repositoryId === finding.repositoryId &&
          candidateDeployment.serviceId === finding.serviceId &&
          candidateDeployment.startedAt >= finding.lastExposedAt! &&
          !candidate.normalized.resolutions.some(({ packageName, version }) =>
            packageName.toLowerCase() === incident.normalizedPackageName &&
            incident.affectedVersions.includes(version)))
        .sort((left, right) => left.candidateDeployment.startedAt - right.candidateDeployment.startedAt)[0];
      if (fixed !== undefined) {
        pending.push(
          {
            type: "FIXED_SNAPSHOT_CREATED",
            at: fixed.candidate.normalized.snapshot.createdAt,
            serviceId: finding.serviceId,
            snapshotId: fixed.candidate.normalized.snapshot.id,
            evidenceRefs: [`E-SNAPSHOT-${fixed.candidate.normalized.snapshot.id}`],
          },
          {
            type: "FIXED_SNAPSHOT_DEPLOYED",
            at: fixed.candidateDeployment.startedAt,
            serviceId: finding.serviceId,
            deploymentId: fixed.candidateDeployment.deploymentId,
            snapshotId: fixed.candidate.normalized.snapshot.id,
            evidenceRefs: [`E-DEPLOYMENT-${fixed.candidateDeployment.deploymentId}`],
          },
        );
      }
    }
  }

  const finalRemovalAt = full.findings.length > 0 && full.findings.every(({ lastExposedAt }) => lastExposedAt !== null)
    ? Math.max(...full.findings.map(({ lastExposedAt }) => lastExposedAt!))
    : undefined;
  if (finalRemovalAt !== undefined) {
    pending.push({
      type: "FINAL_EXPOSURE_PATH_REMOVED",
      at: finalRemovalAt,
      evidenceRefs: [...new Set(full.findings.flatMap(({ evidenceRefs }) => evidenceRefs))],
    });
  }

  const unique = new Map<string, PendingEvent>();
  for (const event of pending) {
    const key = [
      event.type,
      event.at,
      event.serviceId ?? "",
      event.deploymentId ?? "",
      event.snapshotId ?? "",
      event.affectedVersion ?? "",
    ].join(":");
    unique.set(key, event);
  }
  const ordered = [...unique.values()].sort(
    (left, right) =>
      left.at - right.at ||
      left.type.localeCompare(right.type) ||
      (left.serviceId ?? "").localeCompare(right.serviceId ?? ""),
  );
  const events: TimelineEvent[] = ordered.map((event) => {
    const eventId = stableIdFromCanonicalKey(
      `timeline:${incidentId}:${event.type}:${event.at}:${event.serviceId ?? ""}:${event.deploymentId ?? ""}`,
    );
    const exposureCountAfter = analyzeBlastRadius(catalog, incidentId, {
      at: event.at,
      includeDevelopment: false,
      limit: 100,
    }).totalFindings;
    return {
      eventId,
      type: event.type,
      at: event.at,
      exposureCountAfter,
      evidenceRefs: event.evidenceRefs,
      ...(event.serviceId === undefined ? {} : { serviceId: event.serviceId }),
      ...(event.deploymentId === undefined
        ? {}
        : { deploymentId: event.deploymentId }),
      ...(event.snapshotId === undefined ? {} : { snapshotId: event.snapshotId }),
      ...(event.affectedVersion === undefined
        ? {}
        : { affectedVersion: event.affectedVersion }),
    };
  });

  return {
    incidentId,
    startsAt: incident.startsAt ?? null,
    endsAt: incident.endsAt ?? null,
    events,
  };
}
