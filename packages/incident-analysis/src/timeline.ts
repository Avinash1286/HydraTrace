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
    includeDevelopment: true,
    limit: 100,
  });
  const pending: PendingEvent[] = [];

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
      includeDevelopment: true,
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
