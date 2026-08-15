import Fastify from "fastify";
import { buildEngine, graphStoreFromEnvironment } from "./engine.js";

// Vercel's Fastify detector requires the executable entrypoint to import the framework directly.
void Fastify;

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port");
}

const application = buildEngine({ graphStore: graphStoreFromEnvironment() });
application.listen({ host: "0.0.0.0", port }).catch((error: unknown) => {
  application.log.error(error);
  process.exitCode = 1;
});
