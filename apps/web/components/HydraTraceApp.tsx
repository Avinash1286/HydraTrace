"use client";

import { useEffect, useMemo, useState } from "react";
import { GraphPanel, type GraphEdge, type GraphNode } from "./GraphPanel";

type Tab = "overview" | "scan" | "incident" | "graph" | "timeline" | "neighborhood" | "remediation" | "copilot" | "engineering";
interface EvidenceNode { resolutionId: string; packageName: string; version: string; root: boolean; }
interface Finding { findingId: string; serviceId: string; deploymentId: string; repositoryId: string; commitSha: string; lockfileSourceRef: string; lockfileSha256: string; environment: string; criticality: string; snapshotId: string; affectedPackageName: string; affectedVersion: string; advisoryId?: string; incidentSource: "manual" | "osv" | "both"; windowSource: string; firstExposedAt: number; lastExposedAt: number | null; pathCount: number; pathsTruncated: boolean; reachability: number; reachabilityEvidence: Array<{ id: string; source: string; observedAt: number; evidenceRefs: string[]; details: Record<string, unknown> }>; evidenceRefs: string[]; confidence: number; displayedPaths: Array<{ pathId: string; evidenceRefs: string[]; nodes: EvidenceNode[] }>; risk: { score: number; label: string; components: Array<{ name: string; contribution: number }> }; unknowns: string[]; }
interface BlastResult { incidentId: string; generatedAt: number; totalFindings: number; totalAffectedServices: number; totalAffectedDeployments: number; totalPaths: number; findings: Finding[]; }
interface DemoSnapshot { id: string; repositoryId: string; commitSha: string; createdAt: number; }

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
  const [end, setEnd] = useState("2026-08-15T12:00");
  const [environment, setEnvironment] = useState("production");
  const [includeDevelopment, setIncludeDevelopment] = useState(false);
  const [blast, setBlast] = useState<BlastResult | null>(null);
  const [timeline, setTimeline] = useState<Array<{ type: string; at: number; serviceId?: string; exposureCountAfter: number }>>([]);
  const [status, setStatus] = useState("Ready for evidence-backed analysis");
  const [busy, setBusy] = useState(false);
  const [demoSnapshots, setDemoSnapshots] = useState<DemoSnapshot[]>([]);

  useEffect(() => {
    Promise.all([
      fetch(`${apiUrl}/health`).then((response) => response.ok),
      fetch(`${apiUrl}/metrics`).then((response) => response.ok ? response.json() : {}),
    ]).then(([healthy, currentMetrics]) => { setApiHealthy(healthy); setMetrics(currentMetrics as Record<string, unknown>); }).catch(() => setApiHealthy(false));
  }, [apiUrl]);

  useEffect(() => {
    void loadDemo(false);
  // The API URL identifies the deployment whose deterministic demo should be loaded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  async function analyze(): Promise<void> {
    setBusy(true); setStatus("Creating deterministic incident query…");
    try {
      const created = await apiFetch(`${apiUrl}/v1/incidents`, { method: "POST", body: { ecosystem: "npm", packageName, affectedVersions: [version], startsAt: new Date(start).getTime(), endsAt: new Date(end).getTime(), environments: [environment], severityScore: 0.9 } });
      setStatus("Enumerating exact deployment paths…");
      const result = await apiFetch(`${apiUrl}/v1/incidents/${created.incident.id}/blast-radius?includeDevelopment=${includeDevelopment}`);
      const events = await apiFetch(`${apiUrl}/v1/incidents/${created.incident.id}/timeline`);
      setBlast(result as BlastResult); setTimeline(events.events ?? []); setTab("incident"); setStatus(`Analysis complete · ${result.totalPaths} exact path(s)`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Analysis failed"); }
    finally { setBusy(false); }
  }

  async function loadDemo(reset: boolean): Promise<void> {
    setBusy(true); setStatus(reset ? "Resetting deterministic Acme demo…" : "Loading deterministic Acme demo…");
    try {
      const value = await apiFetch(`${apiUrl}/v1/demo${reset ? "/reset" : ""}`, { method: reset ? "POST" : "GET" });
      setBlast(value.blastRadius as BlastResult);
      setTimeline(value.timeline.events ?? []);
      setDemoSnapshots(value.snapshots ?? []);
      setMetrics((current) => ({ ...current, ...(value.stats ?? {}) }));
      setStatus(`Demo ready · ${value.blastRadius.totalPaths} exact path(s) · fictional incident`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Demo could not be loaded");
    } finally { setBusy(false); }
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
        {tab === "overview" && <Overview metrics={metrics} blast={blast} onNew={() => setTab("incident")} onReset={() => void loadDemo(true)} busy={busy} />}
        {tab === "scan" && <NewScan apiUrl={apiUrl} />}
        {tab === "incident" && <IncidentCenter apiUrl={apiUrl} packageName={packageName} version={version} start={start} end={end} environment={environment} includeDevelopment={includeDevelopment} setPackageName={setPackageName} setVersion={setVersion} setStart={setStart} setEnd={setEnd} setEnvironment={setEnvironment} setIncludeDevelopment={setIncludeDevelopment} analyze={analyze} busy={busy} blast={blast} onGraph={() => setTab("graph")} />}
        {tab === "graph" && <GraphView blast={blast} />}
        {tab === "timeline" && <Timeline events={timeline} blast={blast} />}
        {tab === "neighborhood" && <Neighborhood apiUrl={apiUrl} />}
        {tab === "remediation" && <Remediation apiUrl={apiUrl} blast={blast} snapshots={demoSnapshots} />}
        {tab === "copilot" && <Copilot apiUrl={apiUrl} blast={blast} />}
        {tab === "engineering" && <Engineering apiUrl={apiUrl} metrics={metrics} />}
      </section>
    </main>
  </div>;
}

function Overview({ metrics, blast, onNew, onReset, busy }: { metrics: Record<string, unknown>; blast: BlastResult | null; onNew: () => void; onReset: () => void; busy: boolean }) {
  const cards: Array<[string, string | number, string]> = [
    ["Repositories scanned", String(metrics.repositories ?? 0), "+"],
    ["Services monitored", new Set(blast?.findings.map(({ serviceId }) => serviceId) ?? []).size, "◇"],
    ["Package versions", String(metrics.packageVersions ?? 0), "◫"],
    ["Dependency edges", String(metrics.dependencyEdges ?? 0), "↗"],
    ["Active advisories", blast === null ? 0 : 1, "!"],
    ["Production exposures", blast?.findings.filter(({ criticality }) => criticality === "production").length ?? 0, "⌁"],
    ["Runtime-confirmed", blast?.findings.filter(({ reachability }) => reachability >= 3 && reachability <= 4).length ?? 0, "●"],
    ["Last graph update", blast === null ? "—" : new Date(blast.generatedAt).toLocaleTimeString(), "↻"],
  ];
  return <><div className="hero-panel"><div><span className="tag">DETERMINISTIC · TEMPORAL · EVIDENCE-FIRST</span><h2>Trace a compromised package<br />to every deployed service.</h2><p>Exact lockfile resolution graphs, code reachability, runtime evidence, and verified remediation—without letting AI invent the truth.</p><div className="button-row"><button className="primary" onClick={onNew}>Investigate an incident <span>→</span></button><button className="secondary" disabled={busy} onClick={onReset}>{busy ? "Resetting…" : "Reset Acme demo"}</button></div><small className="fictional-label">The Acme Commerce incident and package names are explicitly fictional demo data.</small></div><div className="hydra-orbit"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="core">HT</div><span className="node n1" /><span className="node n2" /><span className="node n3" /></div></div><div className="metric-grid">{cards.map(([label, value, icon]) => <article key={String(label)}><span className="metric-icon">{icon}</span><strong>{String(value)}</strong><small>{label}</small></article>)}</div><div className="two-column"><article className="panel"><div className="panel-title"><h3>Evidence pipeline</h3><span className="tag quiet">LIVE CONTRACT</span></div><div className="pipeline">{["Lockfile", "Canonical graph", "Deployment", "Incident", "Paths", "Verification"].map((label, index) => <div key={label}><span>{index + 1}</span><p>{label}</p>{index < 5 && <i>→</i>}</div>)}</div></article><article className="panel callout"><p className="eyebrow">TRUTH BOUNDARY</p><h3>AI explains. The graph decides.</h3><p>Version matching, exposure, reachability, risk, and remediation verification are deterministic.</p></article></div></>;
}

function NewScan({ apiUrl }: { apiUrl: string }) {
  const [mode, setMode] = useState<"lockfile" | "zip" | "repository">("lockfile");
  const [lockfile, setLockfile] = useState<File | null>(null);
  const [archive, setArchive] = useState<File | null>(null);
  const [manifest, setManifest] = useState<File | null>(null);
  const [staticInput, setStaticInput] = useState<File | null>(null);
  const [runtimeTrace, setRuntimeTrace] = useState<File | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("https://github.com/");
  const [repositoryRef, setRepositoryRef] = useState("HEAD");
  const [lockfilePath, setLockfilePath] = useState("");
  const [repositoryId, setRepositoryId] = useState("acme-commerce/service");
  const [commitSha, setCommitSha] = useState("demo-commit");
  const [environment, setEnvironment] = useState("production");
  const [startedAt, setStartedAt] = useState("2026-08-15T09:00");
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [events, setEvents] = useState<Array<{ stage: string; at: number; message: string }>>([]);
  const [message, setMessage] = useState("Choose a public repository, ZIP, or exact lockfile.");
  async function submit(): Promise<void> {
    if (mode === "lockfile" && lockfile === null) { setMessage("A lockfile is required."); return; }
    if (mode === "zip" && archive === null) { setMessage("A ZIP archive is required."); return; }
    setMessage("Parsing and writing the canonical graph…");
    try {
      const common = {
        mode, observedAt: Date.now(), environment,
        deploymentStartedAt: new Date(startedAt).getTime(),
        serviceId: repositoryId.split("/").at(-1) || "service",
        ...(lockfilePath.trim() === "" ? {} : { lockfilePath: lockfilePath.trim() }),
        ...(manifest === null ? {} : { deploymentManifest: await manifest.text() }),
      };
      const body = mode === "lockfile"
        ? { ...common, repositoryId, commitSha, content: await lockfile!.text(), sourceRef: lockfile!.name }
        : mode === "zip"
          ? { ...common, repositoryId, commitSha, archiveBase64: await fileAsBase64(archive!) }
          : { ...common, repositoryUrl, ref: repositoryRef };
      const value = await apiFetch(`${apiUrl}/v1/scans`, { method: "POST", body });
      if (staticInput !== null) {
        const source = JSON.parse(await staticInput.text()) as Record<string, unknown>;
        await apiFetch(`${apiUrl}/v1/reachability/static`, {
          method: "POST",
          body: { ...source, snapshotId: value.result.snapshot.id, repositoryId: value.repositoryId, commitSha: value.commitSha },
        });
      }
      if (runtimeTrace !== null) {
        const trace = JSON.parse(await runtimeTrace.text()) as Record<string, unknown>;
        await apiFetch(`${apiUrl}/v1/reachability/runtime`, {
          method: "POST",
          body: { ...trace, snapshotId: value.result.snapshot.id },
        });
      }
      const progress = await apiFetch(`${apiUrl}/v1/scans/${value.scanId}/events?limit=100`);
      setEvents(progress.events ?? []);
      setResult(value); setMessage(`Scan ${value.stage.toLowerCase()} · ${progress.total ?? value.eventCount} durable progress events`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Scan failed"); }
  }
  return <><article className="panel incident-form"><div><p className="eyebrow">EXACT INGESTION</p><h2>Import an immutable snapshot</h2><p>Archives are bounded to 4 MB and inspected in memory. Repository scripts and install scripts are never executed.</p><div className="source-tabs">{(["lockfile", "zip", "repository"] as const).map((source) => <button key={source} className={mode === source ? "active" : ""} onClick={() => setMode(source)}>{source}</button>)}</div></div><div className="form-grid">{mode === "repository" && <><label>Public GitHub URL<input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} /></label><label>Branch, tag, or SHA<input value={repositoryRef} onChange={(event) => setRepositoryRef(event.target.value)} /></label><p className="field-note">Repository ID and exact commit SHA are derived from GitHub.</p></>}{mode === "zip" && <label>Repository ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => setArchive(event.target.files?.[0] ?? null)} /></label>}{mode === "lockfile" && <label>Lockfile<input type="file" accept=".json,.yaml,.yml" onChange={(event) => setLockfile(event.target.files?.[0] ?? null)} /></label>}{mode !== "lockfile" && <label>Lockfile path (optional)<input value={lockfilePath} placeholder="apps/api/package-lock.json" onChange={(event) => setLockfilePath(event.target.value)} /></label>}{mode !== "repository" && <><label>Repository ID<input value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} /></label><label>Commit SHA<input value={commitSha} onChange={(event) => setCommitSha(event.target.value)} /></label></>}<label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value)}><option>production</option><option>staging</option><option>development</option></select></label><label>Deployment starts<input type="datetime-local" value={startedAt} onChange={(event) => setStartedAt(event.target.value)} /></label><label>Deployment manifest<input type="file" accept=".json" onChange={(event) => setManifest(event.target.files?.[0] ?? null)} /></label><label>Static-analysis JSON (optional)<input type="file" accept=".json" onChange={(event) => setStaticInput(event.target.files?.[0] ?? null)} /></label><label>Runtime trace JSON (optional)<input type="file" accept=".json" onChange={(event) => setRuntimeTrace(event.target.files?.[0] ?? null)} /></label><button className="primary" onClick={submit}>Start scan</button></div></article><article className="panel"><div className="panel-title"><h3>Scan progress</h3><span className="tag quiet">IDEMPOTENT · CONVEX-DURABLE</span></div><p>{message}</p>{events.length > 0 && <div className="pipeline">{events.map((event, index) => <div key={`${event.stage}:${event.at}:${index}`} title={event.message}><span>{index + 1}</span><p>{event.stage.replaceAll("_", " ")}</p>{index < events.length - 1 && <i>→</i>}</div>)}</div>}{result !== null && <div className="contract-grid"><p><strong>{String(result.stage)}</strong>Terminal workflow state</p><p><strong>{String(result.result?.counts?.resolutions ?? 0)}</strong>Resolution instances</p><p><strong>{String(result.result?.counts?.dependencyEdges ?? 0)}</strong>Dependency edges</p><p><strong>{String(result.result?.graphWrite?.nodes?.created ?? 0)}</strong>New graph nodes</p></div>}</article></>;
}

function IncidentCenter(props: { apiUrl: string; packageName: string; version: string; start: string; end: string; environment: string; includeDevelopment: boolean; setPackageName: (v: string) => void; setVersion: (v: string) => void; setStart: (v: string) => void; setEnd: (v: string) => void; setEnvironment: (v: string) => void; setIncludeDevelopment: (v: boolean) => void; analyze: () => void; busy: boolean; blast: BlastResult | null; onGraph: () => void }) {
  const [selected, setSelected] = useState<Finding | null>(null);
  async function exportReport(format: "markdown" | "json" | "sarif"): Promise<void> {
    if (props.blast === null) return;
    const response = await fetch(`${props.apiUrl}/v1/incidents/${props.blast.incidentId}/reports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format }) });
    if (!response.ok) throw new Error(`Report export failed (${response.status})`);
    const blob = await response.blob();
    downloadBlob(blob, `hydratrace-${props.blast.incidentId}.${format === "markdown" ? "md" : "json"}`);
  }
  return <><article className="panel incident-form"><div><p className="eyebrow">NEW INCIDENT</p><h2>Define the affected release</h2><p>Exact-version evidence is intersected with immutable, half-open deployment and snapshot intervals.</p></div><div className="form-grid"><label>Package or advisory<input value={props.packageName} onChange={(event) => props.setPackageName(event.target.value)} /></label><label>Exact affected version<input value={props.version} onChange={(event) => props.setVersion(event.target.value)} /></label><label>Incident starts<input type="datetime-local" value={props.start} onChange={(event) => props.setStart(event.target.value)} /></label><label>Incident ends<input type="datetime-local" value={props.end} onChange={(event) => props.setEnd(event.target.value)} /></label><label>Environment<select value={props.environment} onChange={(event) => props.setEnvironment(event.target.value)}><option>production</option><option>staging</option><option>development</option></select></label><label className="checkbox-label"><input type="checkbox" checked={props.includeDevelopment} onChange={(event) => props.setIncludeDevelopment(event.target.checked)} />Include development-only paths</label><button className="primary" disabled={props.busy} onClick={props.analyze}>{props.busy ? "Analyzing…" : "Run blast-radius analysis"}</button></div></article>{props.blast === null ? <Empty title="No incident result yet" text="Ingest a deployment snapshot or reset the built-in demo, then run this exact-version query." /> : <><div className="metric-grid compact">{[["Affected services", props.blast.totalAffectedServices], ["Deployments", props.blast.totalAffectedDeployments], ["Complete paths", props.blast.totalPaths], ["Runtime/test confirmed", props.blast.findings.filter(({ reachability }) => reachability >= 3 && reachability <= 4).length], ["First exposure", new Date(Math.min(...props.blast.findings.map(({ firstExposedAt }) => firstExposedAt))).toLocaleTimeString()], ["Path truncation", props.blast.findings.some(({ pathsTruncated }) => pathsTruncated) ? "YES" : "NO"]].map(([label, value]) => <article key={String(label)}><strong>{value}</strong><small>{label}</small></article>)}</div><div className="report-actions"><span>Export deterministic report:</span>{(["markdown", "json", "sarif"] as const).map((format) => <button className="secondary" key={format} onClick={() => void exportReport(format)}>{format.toUpperCase()}</button>)}</div><div className="finding-list">{props.blast.findings.map((finding) => <article className="finding" key={finding.findingId}><div className="finding-main"><span className={`risk ${finding.risk.label.toLowerCase()}`}>{finding.risk.label} · {finding.risk.score}</span><h3>{finding.serviceId}</h3><p>{finding.environment} · {finding.affectedPackageName}@{finding.affectedVersion}</p><div className="evidence-row"><span>{reachabilityName(finding.reachability)}</span><span>{finding.pathCount} exact path(s)</span><span>{finding.evidenceRefs.length} evidence refs</span><span>confidence {finding.confidence}</span></div></div><div className="score-bars">{finding.risk.components.map((component) => <div key={component.name}><span>{component.name}</span><i><b style={{ width: `${Math.min(100, component.contribution * 4)}%` }} /></i><small>+{component.contribution}</small></div>)}</div><div className="button-column"><button className="secondary" onClick={() => setSelected(finding)}>Inspect evidence</button><button className="secondary" onClick={props.onGraph}>Open graph →</button></div></article>)}</div>{selected !== null && <EvidenceDrawer finding={selected} close={() => setSelected(null)} />}</>}</>;
}

function EvidenceDrawer({ finding, close }: { finding: Finding; close: () => void }) {
  const path = finding.displayedPaths[0];
  return <aside className="evidence-drawer"><div className="panel-title"><div><p className="eyebrow">EVIDENCE {finding.findingId}</p><h2>{finding.serviceId}</h2></div><button className="secondary" onClick={close}>Close</button></div><div className="contract-grid"><p><strong>{finding.deploymentId}</strong>Deployment</p><p><strong>{finding.environment}</strong>Environment · {finding.criticality}</p><p><strong>{finding.snapshotId}</strong>Immutable snapshot</p><p><strong>{finding.repositoryId}</strong>Repository</p><p><strong>{finding.commitSha}</strong>Exact commit</p><p><strong>{finding.lockfileSourceRef}</strong>Lockfile · SHA-256 {finding.lockfileSha256}</p><p><strong>{finding.affectedPackageName}@{finding.affectedVersion}</strong>Exact affected version</p><p><strong>{finding.advisoryId ?? finding.windowSource}</strong>Advisory/window source · {finding.incidentSource}</p><p><strong>{new Date(finding.firstExposedAt).toLocaleString()}</strong>First exposed</p><p><strong>{finding.lastExposedAt === null ? "Still active" : new Date(finding.lastExposedAt).toLocaleString()}</strong>Exposure end</p><p><strong>{reachabilityName(finding.reachability)}</strong>Reachability classification</p><p><strong>{finding.confidence}</strong>Evidence confidence</p></div>{path !== undefined && <div className="path-list"><h3>Complete dependency path</h3><ol>{path.nodes.map((node) => <li key={node.resolutionId}><button onClick={() => void navigator.clipboard.writeText(node.resolutionId)}>{node.packageName}@{node.version}</button><small>{node.resolutionId}</small></li>)}</ol></div>}<h3>Static/runtime evidence</h3><div className="evidence-row">{finding.reachabilityEvidence.length === 0 ? <span>No code/runtime observation is available.</span> : finding.reachabilityEvidence.flatMap(({ source, evidenceRefs }) => evidenceRefs.map((reference) => <button key={`${source}:${reference}`} onClick={() => void navigator.clipboard.writeText(reference)}>{source}: {reference}</button>))}</div><h3>Evidence references</h3><div className="evidence-row">{finding.evidenceRefs.map((reference) => <button key={reference} onClick={() => void navigator.clipboard.writeText(reference)}>{reference}</button>)}</div>{finding.unknowns.length > 0 && <div className="warning-box"><strong>Unknown information</strong><p>{finding.unknowns.join(" · ")}</p></div>}</aside>;
}

function GraphView({ blast }: { blast: BlastResult | null }) {
  const [productionOnly, setProductionOnly] = useState(false);
  const [reachableOnly, setReachableOnly] = useState(false);
  const [shortestOnly, setShortestOnly] = useState(false);
  const [affectedOnly, setAffectedOnly] = useState(false);
  const [depth, setDepth] = useState(16);
  const [selectedId, setSelectedId] = useState<string>();
  const filteredBlast = useMemo(() => blast === null ? null : ({
    ...blast,
    findings: blast.findings
      .filter(({ criticality }) => !productionOnly || criticality === "production")
      .filter(({ reachability }) => !reachableOnly || (reachability >= 2 && reachability <= 4))
      .map((finding) => ({ ...finding, displayedPaths: shortestOnly ? finding.displayedPaths.slice(0, 1) : finding.displayedPaths })),
  }), [blast, productionOnly, reachableOnly, shortestOnly]);
  const serverBounded = useMemo(() => graphFromBlast(filteredBlast), [filteredBlast]);
  const visible = useMemo(() => graphAtDepth(serverBounded, depth, affectedOnly), [serverBounded, depth, affectedOnly]);
  const copyEvidence = (): void => { const value = selectedId ?? blast?.findings.flatMap(({ evidenceRefs }) => evidenceRefs).join("\n"); if (value !== undefined) void navigator.clipboard.writeText(value); };
  return <article className="panel graph-panel"><div className="panel-title"><div><p className="eyebrow">BOUNDED SERVER-SIDE SUBGRAPH</p><h2>Complete dependency evidence paths</h2></div><div className="legend"><span className="service-dot" />Service <span className="package-dot" />Package <span className="affected-dot" />Affected</div></div><div className="graph-controls"><label><input type="checkbox" checked={productionOnly} onChange={(event) => setProductionOnly(event.target.checked)} />Production only</label><label><input type="checkbox" checked={reachableOnly} onChange={(event) => setReachableOnly(event.target.checked)} />Reachable only</label><label><input type="checkbox" checked={affectedOnly} onChange={(event) => setAffectedOnly(event.target.checked)} />Affected nodes only</label><label><input type="checkbox" checked={shortestOnly} onChange={(event) => setShortestOnly(event.target.checked)} />Shortest path per finding</label><button className="secondary" onClick={() => setDepth((value) => Math.min(16, value + 1))}>Expand one hop</button><button className="secondary" onClick={() => setDepth(1)}>Collapse path</button><button className="secondary" onClick={copyEvidence}>{selectedId === undefined ? "Copy evidence IDs" : "Copy selected node ID"}</button><span>Depth {depth} · select any node to copy its ID. The full graph never enters the browser.</span></div>{blast === null ? <Empty title="Nothing to graph" text="Run an incident analysis first." /> : <><GraphPanel nodes={visible.nodes} edges={visible.edges} selectedId={selectedId} onSelect={setSelectedId} /><div className="graph-footer"><span>{visible.nodes.length} visible nodes</span><span>{visible.edges.length} relationships</span><span>Maximum path depth 16</span><span>{blast.totalPaths} complete server-counted paths</span></div></>}</article>;
}

function Timeline({ events, blast }: { events: Array<{ type: string; at: number; serviceId?: string; exposureCountAfter: number }>; blast: BlastResult | null }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [service, setService] = useState("all");
  useEffect(() => {
    if (!playing || events.length < 2) return;
    const timer = window.setInterval(() => setIndex((current) => current >= events.length - 1 ? 0 : current + 1), 900);
    return () => window.clearInterval(timer);
  }, [playing, events.length]);
  useEffect(() => { setIndex(Math.max(0, events.length - 1)); }, [events.length]);
  const selected = events[Math.min(index, Math.max(0, events.length - 1))];
  const at = selected?.at ?? 0;
  const visibleBlast = useMemo(() => blast === null ? null : ({
    ...blast,
    findings: blast.findings.filter((finding) =>
      (service === "all" || finding.serviceId === service) &&
      finding.firstExposedAt <= at && (finding.lastExposedAt === null || at < finding.lastExposedAt)),
  }), [blast, at, service]);
  const visibleGraph = useMemo(() => graphFromBlast(visibleBlast), [visibleBlast]);
  const maximum = Math.max(1, ...events.map(({ exposureCountAfter }) => exposureCountAfter));
  const services = [...new Set(blast?.findings.map(({ serviceId }) => serviceId) ?? [])];
  return <article className="panel"><div className="panel-title"><div><p className="eyebrow">HISTORICAL REPLAY</p><h2>Exposure changes at timestamp T</h2></div><span className="tag quiet">HALF-OPEN INTERVALS</span></div>{events.length === 0 ? <Empty title="No timeline events" text="Run an incident analysis to replay deployment exposure." /> : <><div className="timeline-controls"><button className="secondary" onClick={() => setPlaying((value) => !value)}>{playing ? "Pause" : "Play replay"}</button><input aria-label="Timeline event" type="range" min={0} max={events.length - 1} value={index} onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }} /><select value={service} onChange={(event) => setService(event.target.value)}><option value="all">All services</option>{services.map((name) => <option key={name}>{name}</option>)}</select><strong>{selected === undefined ? "—" : new Date(selected.at).toLocaleString()}</strong><span>{visibleBlast?.findings.length ?? 0} active deployment finding(s)</span></div><GraphPanel nodes={visibleGraph.nodes} edges={visibleGraph.edges} /><div className="timeline">{events.map((event, eventIndex) => <button className={`timeline-event ${eventIndex === index ? "selected" : ""}`} onClick={() => { setPlaying(false); setIndex(eventIndex); }} key={`${event.type}-${event.at}-${eventIndex}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span className="timeline-marker" /><span><strong>{event.type.replaceAll("_", " ")}</strong><small>{event.serviceId ?? "Incident"}</small></span><i><b style={{ width: `${event.exposureCountAfter / maximum * 100}%` }} /></i><em>{event.exposureCountAfter} exposed</em></button>)}</div></>}</article>;
}

function Neighborhood({ apiUrl }: { apiUrl: string }) {
  const [name, setName] = useState("compromised-helper"); const [version, setVersion] = useState("1.4.2"); const [value, setValue] = useState<Record<string, any> | null>(null); const [message, setMessage] = useState("Load the evidence-backed package neighborhood."); const [filter, setFilter] = useState("ALL");
  async function lookup(): Promise<void> { try { const result = await apiFetch(`${apiUrl}/v1/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}/neighborhood`); setValue(result); setMessage(`${result.relations.length} evidence-backed relation(s)`); } catch (error) { setMessage(error instanceof Error ? error.message : "Lookup failed"); } }
  const relations = (value?.relations ?? []).filter((relation: any) => filter === "ALL" || relation.type === filter);
  return <article className="panel"><div className="panel-title"><div><p className="eyebrow">INDICATORS, NOT VERDICTS</p><h2>Package neighborhood</h2></div><span className="tag quiet">REASONS REQUIRED</span></div><div className="form-grid inline-form"><label>Package<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Version<input value={version} onChange={(event) => setVersion(event.target.value)} /></label><button className="primary" onClick={lookup}>Find related packages</button></div><div className="source-tabs">{[["ALL", "All"], ["SHARED_MAINTAINER", "Maintainers"], ["SHARED_INFRASTRUCTURE", "Infrastructure"], ["SIMILAR_NAME", "Similar names"]].map(([id, label]) => <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id!)}>{label}</button>)}</div><p>{message}</p>{relations.map((relation: any) => <div className="change" key={relation.relationId}><span>◌</span><div><h3>{relation.target.name}@{relation.target.version}</h3><p>{relation.type.replaceAll("_", " ")} · score {relation.score}</p><div className="evidence-row">{relation.reasons.map((reason: string) => <span key={reason}>{reason}</span>)}<span>indicator only—not a malicious verdict</span></div></div></div>)}</article>;
}

function Remediation({ apiUrl, blast, snapshots }: { apiUrl: string; blast: BlastResult | null; snapshots: DemoSnapshot[] }) {
  const [run, setRun] = useState<Record<string, any> | null>(null); const [message, setMessage] = useState("Generate server-side candidates, then solve exact weighted path cover."); const [packageJson, setPackageJson] = useState<File | null>(null); const [packageLock, setPackageLock] = useState<File | null>(null); const [simulation, setSimulation] = useState<Record<string, any> | null>(null);
  async function propose(): Promise<void> { if (blast === null) return; try { const generated = await apiFetch(`${apiUrl}/v1/incidents/${blast.incidentId}/remediations/candidates`); const value = await apiFetch(`${apiUrl}/v1/incidents/${blast.incidentId}/remediations`, { method: "POST", body: { candidates: generated.candidates } }); setRun(value); setMessage(value.solution.uncoveredPathIds.length === 0 ? "Every enumerated path is covered by the minimum safe candidate set." : `${value.solution.uncoveredPathIds.length} paths remain uncovered.`); } catch (error) { setMessage(error instanceof Error ? error.message : "Proposal failed"); } }
  async function simulate(): Promise<void> { const candidate = run?.solution?.candidates?.[0]?.candidate; if (candidate === undefined || packageJson === null || packageLock === null || blast === null) { setMessage("Choose package.json and package-lock.json after generating a proposal."); return; } try { const value = await apiFetch(`${apiUrl}/v1/remediations/simulate`, { method: "POST", body: { packageJson: await packageJson.text(), packageLock: await packageLock.text(), dependencyName: candidate.dependencyName, toVersion: candidate.toVersion, affectedPackageName: blast.findings[0]?.affectedPackageName, affectedVersions: [...new Set(blast.findings.map(({ affectedVersion }) => affectedVersion))], repositoryId: blast.findings[0]?.repositoryId, commitSha: "remediation-simulation" } }); setSimulation(value); setMessage(`${value.verification} · ${value.affectedPathCount} affected path(s) in regenerated lockfile`); } catch (error) { setMessage(error instanceof Error ? error.message : "Simulation failed"); } }
  async function verify(): Promise<void> { if (run === null) return; const fixed = snapshots.filter(({ commitSha }) => commitSha.startsWith("4")).map(({ id }) => id); if (fixed.length === 0) { setMessage("Ingest fixed snapshots before graph verification."); return; } try { const value = await apiFetch(`${apiUrl}/v1/remediations/${run.runId}/verify`, { method: "POST", body: { snapshotIds: fixed } }); setRun(value); setMessage(value.verification.message); } catch (error) { setMessage(error instanceof Error ? error.message : "Verification failed"); } }
  const after = run?.verification?.remainingPathCount;
  return <><article className="panel"><div className="panel-title"><div><p className="eyebrow">CANDIDATES → SANDBOX → SET COVER → STRONG QUERY</p><h2>Smallest safe change set</h2></div><span className={`tag ${run?.status === "VERIFIED" ? "quiet" : "warning"}`}>{run?.status ?? "VERIFICATION REQUIRED"}</span></div>{blast === null ? <Empty title="No paths to remediate" text="Run an incident analysis first." /> : <div className="remediation-plan"><div className="button-row"><button className="primary" onClick={propose}>Generate and solve candidates</button><button className="secondary" disabled={run === null} onClick={verify}>Run strong graph verification</button></div><p>{message}</p>{run?.solution?.candidates?.map(({ candidate, cost }: any, index: number) => <div className="change" key={candidate.candidateId}><span>{index + 1}</span><div><h3>Upgrade {candidate.dependencyName} {candidate.fromVersion} → {candidate.toVersion}</h3><p>{candidate.semverImpact} impact · transparent cost {cost.total} · {candidate.eliminatedPathIds.length} paths covered · {candidate.affectedServices.join(", ")}</p></div></div>)}<div className="simulation-box"><h3>Safe real lockfile simulation</h3><p>Runs <code>npm install --package-lock-only --ignore-scripts</code> as a bounded, secret-stripped child process.</p><div className="form-grid inline-form"><label>package.json<input type="file" accept=".json" onChange={(event) => setPackageJson(event.target.files?.[0] ?? null)} /></label><label>package-lock.json<input type="file" accept=".json" onChange={(event) => setPackageLock(event.target.files?.[0] ?? null)} /></label><button className="secondary" onClick={simulate}>Regenerate lockfile</button></div>{simulation !== null && <p><strong>{simulation.verification}</strong> · {simulation.lockfileChurn} changed lines · exit {simulation.exitCode}</p>}</div><div className="before-after"><div><small>BEFORE</small><strong>{blast.totalPaths}</strong><span>affected paths</span></div><i>→</i><div><small>AFTER {run?.verification?.level ?? "STRONG QUERY"}</small><strong>{after ?? "—"}</strong><span>{run?.verification?.passed ? "verified remaining paths" : "not yet strongly verified"}</span></div></div>{run?.verification?.passed !== true && <div className="warning-box"><strong>HydraTrace refuses to overclaim.</strong><p>{run?.verification?.message ?? "A fresh lockfile must be written and a strong-consistency HydraDB query must return zero paths for every affected service."}</p></div>}</div>}</article></>;
}

function Copilot({ apiUrl, blast }: { apiUrl: string; blast: BlastResult | null }) {
  const [question, setQuestion] = useState("Which service is most urgent, and what evidence is still missing?"); const [answer, setAnswer] = useState<Record<string, any> | null>(null); const [message, setMessage] = useState("Answers are constrained to deterministic evidence references.");
  async function ask(): Promise<void> { if (blast === null) return; setMessage("Grounding response…"); try { const value = await apiFetch(`${apiUrl}/v1/incidents/${blast.incidentId}/copilot`, { method: "POST", body: { question } }); setAnswer(value); setMessage(`${value.provider} · prompt ${value.promptVersion}`); } catch (error) { setMessage(error instanceof Error ? error.message : "Copilot failed"); } }
  return <article className="panel"><div className="panel-title"><div><p className="eyebrow">EVIDENCE-GROUNDED EXPLANATION</p><h2>Incident copilot</h2></div><span className="tag quiet">DETERMINISTIC FALLBACK</span></div>{blast === null ? <Empty title="No active incident context" text="Run an incident analysis before asking the copilot." /> : <><label className="question-box">Question<textarea value={question} onChange={(event) => setQuestion(event.target.value)} /><button className="primary" onClick={ask}>Ask HydraTrace</button></label><p>{message}</p>{answer !== null && <div className="copilot-answer"><span className={`risk ${String(answer.severity)}`}>{String(answer.severity)}</span><h3>{String(answer.answer)}</h3><div className="evidence-row">{answer.evidenceRefs.map((reference: string) => <button title="Copy evidence reference" onClick={() => void navigator.clipboard.writeText(reference)} key={reference}>{reference}</button>)}</div>{answer.unknowns.length > 0 && <div className="warning-box"><strong>Unknown evidence</strong><p>{answer.unknowns.join(" · ")}</p></div>}<ol>{answer.recommendedActions.map((action: string) => <li key={action}>{action}</li>)}</ol></div>}</>}</article>;
}

function Engineering({ apiUrl, metrics }: { apiUrl: string; metrics: Record<string, unknown> }) {
  const [system, setSystem] = useState<Record<string, any> | null>(null);
  useEffect(() => { void apiFetch(`${apiUrl}/v1/system`).then(setSystem).catch(() => setSystem(null)); }, [apiUrl]);
  const cards: Array<[string, string]> = [
    ["Consistency", String(metrics.graphConsistency ?? "unknown")],
    ["Path cap", "16 hops"],
    ["Indexer", system?.indexer?.healthy === true ? "healthy" : system?.indexer?.configured ? "degraded" : "not configured"],
    ["Persistence", "S3-compatible object store"],
    ["Query p95", `${Number(metrics.hydratrace_http_request_duration_seconds_p95 ?? 0).toFixed(3)} s`],
    ["Last index success", system?.indexer?.lastSuccessfulCycleAt ? new Date(system.indexer.lastSuccessfulCycleAt).toLocaleTimeString() : "unavailable"],
  ];
  return <><article className="panel engineering"><div><p className="eyebrow">BEST USE OF HYDRADB</p><h2>Why the graph is the evidence substrate</h2><p>HydraTrace stores canonical package versions separately from snapshot-specific resolution instances, preserving peer, optional, development, and multi-version topology. A relational or vector-only store would require recursive joins or approximate retrieval where exact ordered path evidence is required.</p></div><div className="schema-code"><span>Service</span><i>DEPLOYS</i><span>Deployment</span><i>USES_SNAPSHOT</i><span>LockfileSnapshot</span><i>CONTAINS</i><span>Resolution</span><i>DEPENDS_ON_INSTANCE</i><span className="hot">Resolution</span></div></article><div className="metric-grid">{cards.map(([label, value]) => <article key={label}><strong className="text-value">{value}</strong><small>{label}</small></article>)}</div><article className="panel"><h3>Native graph query contract</h3><div className="contract-grid"><p><strong>SPpaths / bounded depth 16</strong>Ordered source-to-target evidence paths use HydraDB native traversal.</p><p><strong>{String(system?.graph?.provider ?? "unknown")}</strong>Current graph provider · {String(system?.graph?.consistency ?? "unknown")} consistency.</p><p><strong>Canonical 63-bit IDs</strong>Same fact receives the same identity across imports.</p><p><strong>Immutable snapshots</strong>Historical deployments never mutate under a new scan.</p><p><strong>Complete bounded paths</strong>Path counts stay separate from the UI display limit.</p><p><strong>Strong verification</strong>Only zero-path strong reads for every affected service can mark remediation passed.</p></div></article></>;
}

function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span>⌁</span><h3>{title}</h3><p>{text}</p></div>; }
function reachabilityName(level: number): string { return ["Not present", "Installed only", "Static reachable", "Test observed", "Runtime observed", "Unknown dynamic"][level] ?? "Unknown"; }
function graphFromBlast(blast: BlastResult | null): { nodes: GraphNode[]; edges: GraphEdge[] } { const nodes = new Map<string, GraphNode>(); const edges = new Map<string, GraphEdge>(); if (blast === null) return { nodes: [], edges: [] }; const advisory = `incident:${blast.incidentId}`; nodes.set(advisory, { id: advisory, label: "Incident / advisory", kind: "advisory" }); for (const finding of blast.findings) { const service = `service:${finding.serviceId}`; const deployment = `deployment:${finding.deploymentId}`; const snapshot = `snapshot:${finding.snapshotId}`; const packageVersion = `package-version:${finding.affectedPackageName}@${finding.affectedVersion}`; nodes.set(service, { id: service, label: finding.serviceId, kind: "service" }); nodes.set(deployment, { id: deployment, label: `Deployment\n${finding.environment}`, kind: "context" }); nodes.set(snapshot, { id: snapshot, label: "Lockfile snapshot", kind: "context" }); nodes.set(packageVersion, { id: packageVersion, label: `${finding.affectedPackageName}\n${finding.affectedVersion}`, kind: "affected" }); addGraphEdge(edges, advisory, packageVersion); for (const path of finding.displayedPaths) { const reversed = [...path.nodes].reverse(); let previous = packageVersion; for (const node of reversed) { const id = node.resolutionId; nodes.set(id, { id, label: `${node.packageName}\n${node.version}`, kind: node.packageName === finding.affectedPackageName && node.version === finding.affectedVersion ? "affected" : "package" }); addGraphEdge(edges, previous, id); previous = id; } addGraphEdge(edges, previous, snapshot); addGraphEdge(edges, snapshot, deployment); addGraphEdge(edges, deployment, service); } } return { nodes: [...nodes.values()], edges: [...edges.values()] }; }
function addGraphEdge(edges: Map<string, GraphEdge>, source: string, target: string): void { const id = `${source}:${target}`; edges.set(id, { id, source, target }); }
function graphAtDepth(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, maximumDepth: number, affectedOnly: boolean): { nodes: GraphNode[]; edges: GraphEdge[] } { const incoming = new Set(graph.edges.map(({ target }) => target)); const roots = graph.nodes.filter(({ id }) => !incoming.has(id)).map(({ id }) => id); const depth = new Map(roots.map((id) => [id, 0])); const pending = [...roots]; while (pending.length > 0) { const current = pending.shift()!; const currentDepth = depth.get(current)!; if (currentDepth >= maximumDepth) continue; for (const edge of graph.edges.filter(({ source }) => source === current)) if (!depth.has(edge.target)) { depth.set(edge.target, currentDepth + 1); pending.push(edge.target); } } const nodes = graph.nodes.filter((node) => depth.has(node.id) && (!affectedOnly || ["advisory", "affected"].includes(node.kind))); const ids = new Set(nodes.map(({ id }) => id)); return { nodes, edges: graph.edges.filter(({ source, target }) => ids.has(source) && ids.has(target)) }; }
async function apiFetch(url: string, init?: { method?: string; body?: unknown }): Promise<any> { const response = await fetch(url, { method: init?.method ?? "GET", headers: init?.body === undefined ? {} : { "content-type": "application/json" }, ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }) }); const value = await response.json(); if (!response.ok) throw new Error(value.message ?? value.error ?? `Request failed (${response.status})`); return value; }

async function fileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
