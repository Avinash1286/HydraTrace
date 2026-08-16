import { SystemStatusPage } from "../../components/SystemStatusPage";

export default function SystemPage() {
  return <SystemStatusPage apiUrl={process.env.NEXT_PUBLIC_HYDRATRACE_API_URL ?? "http://127.0.0.1:4100"} />;
}

