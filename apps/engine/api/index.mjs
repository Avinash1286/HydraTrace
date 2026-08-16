// Replaced by the deterministic esbuild bundle during `vercel-build`.
export default function buildRequired(_request, response) {
  response.statusCode = 503;
  response.end("HydraTrace engine bundle has not been built");
}
