import type { IncomingMessage, ServerResponse } from "node:http";
import { buildEngine, graphStoreFromEnvironment } from "../src/engine.js";

const application = buildEngine({ graphStore: graphStoreFromEnvironment() });
const ready = application.ready();

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await ready;
  application.server.emit("request", request, response);
}
