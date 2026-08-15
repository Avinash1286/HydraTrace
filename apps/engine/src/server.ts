import { buildEngine, graphStoreFromEnvironment } from "./engine.js";

const host =
  process.env.ENGINE_HOST ?? (process.env.VERCEL === "1" ? "0.0.0.0" : "127.0.0.1");
const parsedPort = Number(process.env.PORT ?? process.env.ENGINE_PORT ?? "4100");
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new Error("ENGINE_PORT must be a valid TCP port");
}

const application = buildEngine({ graphStore: graphStoreFromEnvironment() });

try {
  await application.listen({ host, port: parsedPort });
} catch (error) {
  application.log.error(error);
  process.exitCode = 1;
}
