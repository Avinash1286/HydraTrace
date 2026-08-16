import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.interval("reclaim expired scan workers", { seconds: 30 }, internal.jobs.reclaimExpired, {});
crons.interval("delete expired callback replay keys", { minutes: 10 }, internal.callbacks.deleteExpiredReplayKeys, {});
export default crons;
