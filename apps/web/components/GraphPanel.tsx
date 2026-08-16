"use client";

import cytoscape from "cytoscape";
import { useEffect, useRef } from "react";

export interface GraphNode { id: string; label: string; kind: "service" | "package" | "affected"; }
export interface GraphEdge { id: string; source: string; target: string; }

export function GraphPanel({ nodes, edges }: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (element.current === null) return;
    const graph = cytoscape({
      container: element.current,
      elements: [
        ...nodes.map((node) => ({ data: node, classes: node.kind })),
        ...edges.map((edge) => ({ data: edge })),
      ],
      style: [
        { selector: "node", style: { label: "data(label)", color: "#dce6f2", "font-size": 11, "text-valign": "bottom", "text-margin-y": 8, width: 35, height: 35, "background-color": "#3578a8", "border-width": 2, "border-color": "#79b8e8" } },
        { selector: ".service", style: { shape: "round-rectangle", width: 72, "background-color": "#6b5ce7", "border-color": "#a79cff" } },
        { selector: ".affected", style: { "background-color": "#ef6b5b", "border-color": "#ffae9f", width: 45, height: 45 } },
        { selector: "edge", style: { width: 1.5, "line-color": "#46576a", "target-arrow-color": "#71859a", "target-arrow-shape": "triangle", "curve-style": "bezier" } },
      ],
      layout: { name: "breadthfirst", directed: true, padding: 24, spacingFactor: 1.25 },
      minZoom: 0.5,
      maxZoom: 2,
    });
    return () => graph.destroy();
  }, [nodes, edges]);
  return <div className="graph-canvas" ref={element} aria-label="Dependency evidence graph" />;
}
