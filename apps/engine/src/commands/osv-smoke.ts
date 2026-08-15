import { FileResponseCache, OsvClient } from "@hydratrace/ecosystem-enrichment";

const client = new OsvClient({
  cache: new FileResponseCache(".cache"),
  ...(process.env.OSV_BASE_URL === undefined
    ? {}
    : { baseUrl: process.env.OSV_BASE_URL }),
});
const [result] = await client.queryExactPackages([
  { ecosystem: "npm", name: "lodash", version: "4.17.20" },
]);
if (result === undefined || result.advisories.length === 0) {
  throw new Error("OSV smoke query returned no advisories for lodash@4.17.20");
}
process.stdout.write(
  `${JSON.stringify(
    {
      status: "passed",
      query: result.query,
      advisoryCount: result.advisoryIds.length,
      advisoryIds: result.advisoryIds,
    },
    null,
    2,
  )}\n`,
);
