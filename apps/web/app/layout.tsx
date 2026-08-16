import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HydraTrace — Supply-chain incident intelligence",
  description: "Evidence-backed dependency blast radius, reachability, and verified remediation.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
