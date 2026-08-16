import { HydraTraceApp } from "../components/HydraTraceApp";

export default function Page() {
  return <HydraTraceApp apiUrl={process.env.NEXT_PUBLIC_HYDRATRACE_API_URL ?? "http://127.0.0.1:4100"} />;
}
