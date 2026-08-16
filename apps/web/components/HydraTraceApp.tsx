"use client";

import { useEffect, useMemo, useState } from "react";
import { GraphPanel, type GraphEdge, type GraphNode } from "./GraphPanel";

type Tab = "overview" | "scan" | "incident" | "graph" | "timeline" | "neighborhood" | "remediation" | "copilot" | "engineering";
interface EvidenceNode { resolutionId: string; packageName: string; version: string; root: boolean; }
interface Finding { findingId: string; serviceId: string; environment: string; affectedPackageName: string; affectedVersion: string; pathCount: number; reachability: number; evidenceRefs: string[]; displayedPaths: Array<{ pathId: string; nodes: EvidenceNode[] }>; risk: { score: number; label: string; components: Array<{ name: string; contribution: number }> }; unknowns: string[]; }
interface BlastResult { incidentId: string; totalFindings: number; totalAffectedServices: number; totalAffectedDeployments: number; totalPaths: number; findings: Finding[]; }

const nav: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "⌁" },
  { id: "scan", label: "New scan", icon: "＋" },
  { id: "incident", label: "Incident center", icon: "◇" },
  { id: "graph", label: "Blast-radius graph", icon: "⌘" },
  { id: "timeline", label: "Timeline replay", icon: "↝" },
  { id: "neighborhood", label: "Package neighborhood", icon: "◌" },
  { id: "remediation", label: "Remediation", icon: "✓" },
  { id: "copilot", label: "Incident copilot", icon: "✦" },
  { id: "engineering", label: "How HydraDB is used", icon: "◎" },
];

export function HydraTraceApp({ apiUrl }: { apiUrl: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown>>({});
  const [packageName, setPackageName] = useState("compromised-helper");
  const [version, setVersion] = useState("1.4.2");
  const [start, setStart] = useState("2026-08-15T09:02");
  const [blast, setBlast] = useState<BlastResult | null>(null);
  const [timeline, setTimeline] = useState<Array<{ type: string; at: number; serviceId?: string; exposureCountAfter: number }>>([]);
  const [status, setStatus] = useState("Ready for evidence-backed analysis");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`${apiUrl}/health`).then((response) => response.ok),
      fetch(`${apiUrl}/metrics`).then((response) => response.ok ? response.json() : {}),
    ]).then(([healthy, currentMetrics]) => { setApiHealthy(healthy); setMetrics(currentMetrics as Record<string, unknown>); }).catch(() => setApiHealthy(false));
  }, [apiUrl]);

  const graph = useMemo(() => graphFromBlast(blast), [blast]);
  async function analyze(): Promise<void> {
    setBusy(true); setStatus("Creating deterministic incident query…");
    try {
      const created = await apiFetch(`${apiUrl}/v1/incidents`, { method: "POST", body: { ecosystem: "npm", packageName, affectedVersions: [version], startsAt: new Date(start).getTime(), severityScore: 0.9 } });
      setStatus("Enumerating exact deployment paths…");
      const result = await apiFetch(`${apiUrl}/v1/incidents/${created.incident.id}/blast-radius`);
      const events = await apiFetch(`${apiUrl}/v1/incidents/${created.incident.id}/timeline`);
      setBlast(result as BlastResult); setTimeline(events.events ?? []); setTab("incident"); setStatus(`Analysis complete · ${result.totalPaths} exact path(s)`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Analysis failed"); }
    finally { setBusy(false); }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">H</span><div><strong>HydraTrace</strong><small>DEPENDENCY INTELLIGENCE</small></div></div>
      <nav>{nav.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav>
      <div className="sidebar-foot"><div className={`status-dot ${apiHealthy ? "online" : ""}`} /> <span>{apiHealthy === null ? "Checking engine" : apiHealthy ? "Engine online" : "Engine unavailable"}</span><small>{apiUrl.replace(/^https?:\/\//u, "")}</small></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">SUPPLY-CHAIN INCIDENT WORKSPACE</p><h1>{nav.find(({ id }) => id === tab)?.label}</h1></div><div className="header-status"><span className="pulse" />{status}</div></header>
      <section className="content">
        {tab === "overview" && <Overview metrics={metrics} blast={blast} onNew={() => setTab("incident")} />}
        {tab === "scan" && <NewScan apiUrl={apiUrl} />}
        {tab === "incident" && <IncidentCenter packageName={packageName} version={version} start={start} setPackageName={setPackageName} setVersion={setVersion} setStart={setStart} analyze={analyze} busy={busy} blast={blast} onGraph={() => setTab("graph")} />}
        {tab === "graph" && <GraphView blast={blast} graph={graph} />}
        {tab === "timeline" && <Timeline events={timeline} />}
        {tab === "neighborhood" && <Neighborhood apiUrl={apiUrl} />}
        {tab === "remediation" && <Remediation apiUrl={apiUrl} blast={blast} />}
        {tab === "copilot" && <Copilot apiUrl={apiUrl} blast={blast} />}
        {tab === "engineering" && <Engineering metrics={metrics} />}
      </section>
    </main>
  </div>;
}

function Overview({ metrics, blast, onNew }: { metrics: Record<string, unknown>; blast: BlastResult | null; onNew: () => void }) {
  const cards: Array<[string, string | number, string]> = [
    ["Repositories scanned", String(metrics.repositories ?? 0), "+"], ["Immutable snapshots", String(metrics.snapshots ?? 0), "#"], ["Package versions", String(metrics.packageVersions ?? 0), "◫"], ["Dependency edges", String(metrics.dependencyEdges ?? 0), "↗"], ["Active findings", blast?.totalFindings ?? 0, "!"], ["Exact evidence paths", blast?.totalPaths ?? 0, "⌁"],
  ];
  return <><div className="hero-panel"><div><span className="tag">DETERMINISTIC · TEMPORAL · EVIDENCE-FIRST</span><h2>Trace a compromised package<br />to every deployed service.</h2><p>Exact lockfile resolution graphs, code reachability, runtime evidence, and verified remediation—without letting AI invent the truth.</p><button className="primary" onClick={onNew}>Investigate an incident <span>→</span></button></div><div className="hydra-orbit"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="core">HT</div><span className="node n1" /><span className="node n2" /><span className="node n3" /></div></div><div className="metric-grid">{cards.map(([label, value, icon]) => <article key={String(label)}><span className="metric-icon">{icon}</span><strong>{String(value)}</strong><small>{label}</small></article>)}</div><div className="two-column"><article className="panel"><div className="panel-title"><h3>Evidence pipeline</h3><span className="tag quiet">LIVE CONTRACT</span></div><div className="pipeline">{["Lockfile", "Canonical graph", "Deployment", "Incident", "Paths", "Verification"].map((label, index) => <div key={label}><span>{index + 1}</span><p>{label}</p>{index < 5 && <i>→</i>}</div>)}</div></article><article className="panel callout"><p className="eyebrow">TRUTH BOUNDARY</p><h3>AI explains. The graph decides.</h3><p>Version matching, exposure, reachability, risk, and remediation verification are deterministic.</p></article></div></>;
}

function NewScan({ apiUrl }: { apiUrl: string }) {
  const [lockfile, setLockfile] = useState<File | null>(null);
  const [manifest, setManifest] = useState<File | null>(null);
  const [repositoryId, setRepositoryId] = useState("acme-commerce/service");
  const [commitSha, setCommitSha] = useState("demo-commit");
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [message, setMessage] = useState("Choose a package-lock.json or pnpm-lock.yaml file.");
  async function submit(): Promise<void> {
    if (lockfile === null) { setMessage("A lockfile is required."); return; }
    setMessage("Parsing and writing the canonical graph…");
    try {
      const body = {
        content: await lockfile.text(), sourceRef: lockfile.name, repositoryId, commitSha,
        observedAt: Date.now(),
        ...(manifest === null ? {} : { deploymentManifest: await manifest.text() }),
      };
      const value = await apiFetch(`${apiUrl}/v1/scans`, { method: "POST", body });
      setResult(value); setMessage(`Scan ${value.stage.toLowerCase()} · ${value.eventCount} progress events`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Scan failed"); }
  }
  return <><article className="panel incident-form"><div><p className="eyebrow">EXACT INGESTION</p><h2>Import an immutable snapshot</h2><p>Only lockfiles and an optional HydraTrace deployment manifest are read. Repository scripts are never executed.</p></div><div className="form-grid"><label>Repository ID<input value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} /></label><label>Commit SHA<input value={commitSha} onChange={(event) => setCommitSha(event.target.value)} /></label><label>Lockfile<input type="file" accept=".json,.yaml,.yml" onChange={(event) => setLockfile(event.target.files?.[0] ?? null)} /></label><label>Deployment manifest<input type="file" accept=".json" onChange={(event) => setManifest(event.target.files?.[0] ?? null)} /></label><button className="primary" onClick={submit}>Start scan</button></div></article><article className="panel"><div className="panel-title"><h3>Scan progress</h3><span className="tag quiet">IDEMPOTENT</span></div><p>{message}</p>{result !== null && <div className="contract-grid"><p><strong>{String(result.stage)}</strong>Terminal workflow state</p><p><strong>{String(result.result?.counts?.resolutions ?? 0)}</strong>Resolution instances</p><p><strong>{String(result.result?.counts?.dependencyEdges ?? 0)}</strong>Dependency edges</p><p><strong>{String(result.result?.graphWrite?.nodes?.created ?? 0)}</strong>New graph nodes</p></div>}</article></>;
}

function IncidentCenter(props: { packageName: string; version: string; start: string; setPackageName: (v: string) => void; setVersion: (v: string) => void; setStart: (v: string) => void; analyze: () => void; busy: boolean; blast: BlastResult | null; onGraph: () => void }) {
  return <><article className="panel incident-form"><div><p className="eyebrow">NEW INCIDENT</p><h2>Define the affected release</h2><p>HydraTrace matches exact versions and intersects the incident window with immutable deployment intervals.</p></div><div className="form-grid"><label>Package<input value={props.packageName} onChange={(event) => props.setPackageName(event.target.value)} /></label><label>Exact affected version<input value={props.version} onChange={(event) => props.setVersion(event.target.value)} /></label><label>Incident starts<input type="datetime-local" value={props.start} onChange={(event) => props.setStart(event.target.value)} /></label><label>Environment<select defaultValue="production"><option>production</option><option>staging</option><option>development</option></select></label><button className="primary" disabled={props.busy} onClick={props.analyze}>{props.busy ? "Analyzing…" : "Run blast-radius analysis"}</button></div></article>{props.blast === null ? <Empty title="No incident result yet" text="Ingest a deployment snapshot through the scan API, then run this exact-version query." /> : <><div className="metric-grid compact">{[["Affected services", props.blast.totalAffectedServices], ["Deployments", props.blast.totalAffectedDeployments], ["Complete paths", props.blast.totalPaths], ["Runtime confirmed", props.blast.findings.filter(({ reachability }) => reachability === 4).length]].map(([label, value]) => <article key={String(label)}><strong>{value}</strong><small>{label}</small></article>)}</div><div className="finding-list">{props.blast.findings.map((finding) => <article className="finding" key={finding.findingId}><div className="finding-main"><span className={`risk ${finding.risk.label.toLowerCase()}`}>{finding.risk.label} · {finding.risk.score}</span><h3>{finding.serviceId}</h3><p>{finding.environment} · {finding.affectedPackageName}@{finding.affectedVersion}</p><div className="evidence-row"><span>{reachabilityName(finding.reachability)}</span><span>{finding.pathCount} exact path(s)</span><span>{finding.evidenceRefs.length} evidence refs</span></div></div><div className="score-bars">{finding.risk.components.map((component) => <div key={component.name}><span>{component.name}</span><i><b style={{ width: `${Math.min(100, component.contribution * 4)}%` }} /></i><small>+{component.contribution}</small></div>)}</div><button className="secondary" onClick={props.onGraph}>Open evidence graph →</button></article>)}</div></>}</>;
}

function GraphView({ blast, graph }: { blast: BlastResult | null; graph: { nodes: GraphNode[]; edges: GraphEdge[] } }) { return <article className="panel graph-panel"><div className="panel-title"><div><p className="eyebrow">BOUNDED PATH VIEW</p><h2>Complete dependency evidence paths</h2></div><div className="legend"><span className="service-dot" />Service <span className="package-dot" />Package <span className="affected-dot" />Affected</div></div>{blast === null ? <Empty title="Nothing to graph" text="Run an incident analysis first." /> : <><GraphPanel nodes={graph.nodes} edges={graph.edges} /><div className="graph-footer"><span>{graph.nodes.length} visible nodes</span><span>{graph.edges.length} relationships</span><span>Maximum path depth 16</span><span>Server-side evidence subset</span></div></>}</article>; }

function Timeline({ events }: { events: Array<{ type: string; at: number; serviceId?: string; exposureCountAfter: number }> }) { const maximum = Math.max(1, ...events.map(({ exposureCountAfter }) => exposureCountAfter)); return <article className="panel"><div className="panel-title"><div><p className="eyebrow">HISTORICAL REPLAY</p><h2>Exposure changes over time</h2></div><span className="tag quiet">HALF-OPEN INTERVALS</span></div>{events.length === 0 ? <Empty title="No timeline events" text="Run an incident analysis to replay deployment exposure." /> : <div className="timeline">{events.map((event, index) => <div className="timeline-event" key={`${event.type}-${event.at}-${index}`}><time>{new Date(event.at).toLocaleString()}</time><span className="timeline-marker" /><div><strong>{event.type.replaceAll("_", " ")}</strong><small>{event.serviceId ?? "Incident"}</small></div><i><b style={{ width: `${event.exposureCountAfter / maximum * 100}%` }} /></i><em>{event.exposureCountAfter} exposed</em></div>)}</div>}</article>; }

function Neighborhood({ apiUrl }: { apiUrl: string }) {
  const [name, setName] = useState("compromised-helper"); const [version, setVersion] = useState("1.4.2"); const [value, setValue] = useState<Record<string, any> | null>(null); const [message, setMessage] = useState("Load npm metadata or submit package metadata through the API first.");
  async function lookup(): Promise<void> { try { const result = await apiFetch(`${apiUrl}/v1/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}/neighborhood`); setValue(result); setMessage(`${result.relations.length} evidence-backed relation(s)`); } catch (error) { setMessage(error instanceof Error ? error.message : "Lookup failed"); } }
  return <article className="panel"><div className="panel-title"><div><p className="eyebrow">INDICATORS, NOT VERDICTS</p><h2>Package neighborhood</h2></div><span className="tag quiet">REASONS REQUIRED</span></div><div className="form-grid inline-form"><label>Package<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Version<input value={version} onChange={(event) => setVersion(event.target.value)} /></label><button className="primary" onClick={lookup}>Find related packages</button></div><p>{message}</p>{value?.relations?.map((relation: any) => <div className="change" key={relation.relationId}><span>◌</span><div><h3>{relation.target.name}@{relation.target.version}</h3><p>{relation.type.replaceAll("_", " ")} · score {relation.score}</p><div className="evidence-row">{relation.reasons.map((reason: string) => <span key={reason}>{reason}</span>)}<span>indicator only</span></div></div></div>)}</article>;
}

function Remediation({ apiUrl, blast }: { apiUrl: string; blast: BlastResult | null }) {
  const paths = blast?.findings.flatMap(({ displayedPaths }) => displayedPaths) ?? []; const [toVersion, setToVersion] = useState("1.4.3"); const [run, setRun] = useState<Record<string, any> | null>(null); const [message, setMessage] = useState("Generate a weighted path-cover proposal.");
  async function propose(): Promise<void> { if (blast === null) return; const candidates = blast.findings.map((finding) => ({ dependencyName: finding.displayedPaths[0]?.nodes[1]?.packageName ?? finding.affectedPackageName, fromVersion: finding.displayedPaths[0]?.nodes[1]?.version ?? finding.affectedVersion, toVersion, semverImpact: "patch", eliminatedPathIds: finding.displayedPaths.map(({ pathId }) => pathId), affectedServices: [finding.serviceId], verification: "PROPOSED" })); try { const value = await apiFetch(`${apiUrl}/v1/incidents/${blast.incidentId}/remediations`, { method: "POST", body: { candidates } }); setRun(value); setMessage(value.solution.uncoveredPathIds.length === 0 ? "All current paths have candidate coverage." : `${value.solution.uncoveredPathIds.length} paths remain uncovered.`); } catch (error) { setMessage(error instanceof Error ? error.message : "Proposal failed"); } }
  return <><article className="panel"><div className="panel-title"><div><p className="eyebrow">WEIGHTED SET COVER</p><h2>Smallest safe change set</h2></div><span className="tag warning">VERIFICATION REQUIRED</span></div>{blast === null ? <Empty title="No paths to remediate" text="Run an incident analysis first." /> : <div className="remediation-plan"><div className="form-grid inline-form"><label>Candidate target version<input value={toVersion} onChange={(event) => setToVersion(event.target.value)} /></label><button className="primary" onClick={propose}>Solve path coverage</button></div><p>{message}</p>{run?.solution?.candidates?.map(({ candidate, cost }: any, index: number) => <div className="change" key={candidate.candidateId}><span>{index + 1}</span><div><h3>Upgrade {candidate.dependencyName} {candidate.fromVersion} → {candidate.toVersion}</h3><p>{candidate.semverImpact} impact · cost {cost.total} · {candidate.eliminatedPathIds.length} paths covered</p></div></div>)}<div className="before-after"><div><small>BEFORE</small><strong>{blast.totalPaths}</strong><span>affected paths</span></div><i>→</i><div><small>AFTER STRONG QUERY</small><strong>—</strong><span>not verified yet</span></div></div><div className="warning-box"><strong>HydraTrace will not display “verified” yet.</strong><p>A fresh lockfile snapshot must be written, then a strong-consistency HydraDB query must return zero paths.</p></div></div>}</article></>;
}

function Copilot({ apiUrl, blast }: { apiUrl: string; blast: BlastResult | null }) {
  const [question, setQuestion] = useState("Which service is most urgent, and what evidence is still missing?"); const [answer, setAnswer] = useState<Record<string, any> | null>(null); const [message, setMessage] = useState("Answers are constrained to deterministic evidence references.");
  async function ask(): Promise<void> { if (blast === null) return; setMessage("Grounding response…"); try { const value = await apiFetch(`${apiUrl}/v1/incidents/${blast.incidentId}/copilot`, { method: "POST", body: { question } }); setAnswer(value); setMessage(`${value.provider} · prompt ${value.promptVersion}`); } catch (error) { setMessage(error instanceof Error ? error.message : "Copilot failed"); } }
  return <article className="panel"><div className="panel-title"><div><p className="eyebrow">EVIDENCE-GROUNDED EXPLANATION</p><h2>Incident copilot</h2></div><span className="tag quiet">DETERMINISTIC FALLBACK</span></div>{blast === null ? <Empty title="No active incident context" text="Run an incident analysis before asking the copilot." /> : <><label className="question-box">Question<textarea value={question} onChange={(event) => setQuestion(event.target.value)} /><button className="primary" onClick={ask}>Ask HydraTrace</button></label><p>{message}</p>{answer !== null && <div className="copilot-answer"><span className={`risk ${String(answer.severity)}`}>{String(answer.severity)}</span><h3>{String(answer.answer)}</h3><div className="evidence-row">{answer.evidenceRefs.map((reference: string) => <span key={reference}>{reference}</span>)}</div>{answer.unknowns.length > 0 && <div className="warning-box"><strong>Unknown evidence</strong><p>{answer.unknowns.join(" · ")}</p></div>}<ol>{answer.recommendedActions.map((action: string) => <li key={action}>{action}</li>)}</ol></div>}</>}</article>;
}

function Engineering({ metrics }: { metrics: Record<string, unknown> }) {
  const cards: Array<[string, string]> = [
    ["Consistency", String(metrics.graphConsistency ?? "unknown")],
    ["Path cap", "16 hops"],
    ["Indexer", "separate service"],
    ["Persistence", "S3-compatible object store"],
  ];
  return <><article className="panel engineering"><div><p className="eyebrow">BEST USE OF HYDRADB</p><h2>Why the graph is the evidence substrate</h2><p>HydraTrace stores canonical package versions separately from snapshot-specific resolution instances, preserving peer, optional, development, and multi-version topology.</p></div><div className="schema-code"><span>Service</span><i>DEPLOYS</i><span>Deployment</span><i>USES_SNAPSHOT</i><span>LockfileSnapshot</span><i>CONTAINS</i><span>Resolution</span><i>DEPENDS_ON_INSTANCE</i><span className="hot">Resolution</span></div></article><div className="metric-grid">{cards.map(([label, value]) => <article key={label}><strong className="text-value">{value}</strong><small>{label}</small></article>)}</div><article className="panel"><h3>Correctness contract</h3><div className="contract-grid"><p><strong>Canonical 63-bit IDs</strong>Same fact receives the same identity across imports.</p><p><strong>Immutable snapshots</strong>Historical deployments never mutate under a new scan.</p><p><strong>Complete bounded paths</strong>Path counts stay separate from the UI display limit.</p><p><strong>Strong verification</strong>Only zero-path strong reads can mark remediation passed.</p></div></article></>;
}

function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span>⌁</span><h3>{title}</h3><p>{text}</p></div>; }
function reachabilityName(level: number): string { return ["Not present", "Installed only", "Static reachable", "Test observed", "Runtime observed", "Unknown dynamic"][level] ?? "Unknown"; }
function graphFromBlast(blast: BlastResult | null): { nodes: GraphNode[]; edges: GraphEdge[] } { const nodes = new Map<string, GraphNode>(); const edges = new Map<string, GraphEdge>(); if (blast === null) return { nodes: [], edges: [] }; for (const finding of blast.findings) { const service = `service:${finding.serviceId}`; nodes.set(service, { id: service, label: finding.serviceId, kind: "service" }); for (const path of finding.displayedPaths) { let previous = service; for (const node of path.nodes) { const id = node.resolutionId; nodes.set(id, { id, label: `${node.packageName}\n${node.version}`, kind: node.packageName === finding.affectedPackageName && node.version === finding.affectedVersion ? "affected" : "package" }); const edgeId = `${previous}:${id}`; edges.set(edgeId, { id: edgeId, source: previous, target: id }); previous = id; } } } return { nodes: [...nodes.values()], edges: [...edges.values()] }; }
async function apiFetch(url: string, init?: { method?: string; body?: unknown }): Promise<any> { const response = await fetch(url, { method: init?.method ?? "GET", headers: init?.body === undefined ? {} : { "content-type": "application/json" }, ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }) }); const value = await response.json(); if (!response.ok) throw new Error(value.message ?? value.error ?? `Request failed (${response.status})`); return value; }
