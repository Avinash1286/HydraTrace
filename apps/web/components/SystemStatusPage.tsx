"use client";

import { useEffect, useState } from "react";

export function SystemStatusPage({ apiUrl }: { apiUrl: string }) {
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${apiUrl}/v1/system`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`System endpoint returned ${response.status}`);
        return response.json() as Promise<Record<string, any>>;
      })
      .then(setStatus)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "System status failed"));
  }, [apiUrl]);
  return <main className="system-page"><a href="/">← HydraTrace dashboard</a><p className="eyebrow">HIDDEN OPERATOR VIEW</p><h1>HydraTrace system status</h1>{error !== null && <div className="warning-box"><strong>Unavailable</strong><p>{error}</p></div>}{status === null && error === null ? <p>Checking engine, graph, indexer, cache, and AI circuit…</p> : status !== null && <><div className="metric-grid">{[["Engine", status.engine?.healthy ? "healthy" : "degraded"], ["Graph", status.graph?.healthy ? status.graph.provider : "degraded"], ["Consistency", status.graph?.consistency], ["Indexer", status.indexer?.healthy === true ? "healthy" : status.indexer?.configured ? "degraded" : "not configured"], ["Cache", status.cache?.status], ["AI fallback", status.ai?.deterministicFallback ? "ready" : "unavailable"]].map(([label, value]) => <article key={label}><strong className="text-value">{String(value ?? "unknown")}</strong><small>{label}</small></article>)}</div><article className="panel"><h2>Raw verified health contract</h2><pre>{JSON.stringify(status, null, 2)}</pre></article></>}</main>;
}

