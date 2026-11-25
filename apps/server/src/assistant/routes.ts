import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/env";
import { AiSettingsStore } from "./ai-settings";
import type { GeoDatasets } from "./geo-datasets";
import { RuleAssistant } from "./rule-assistant";

export function registerAssistantRoutes(
  app: FastifyInstance,
  config: AppConfig,
  geo: GeoDatasets,
) {
  const settings = new AiSettingsStore(app.database, config);
  const assistant = new RuleAssistant(settings, geo);
  const auth = { onRequest: app.requireAuth };
  app.get("/api/system/ai", auth, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { ok: true, data: { ...settings.status(), datasets: geo.status() } };
  });
  app.put(
    "/api/system/ai",
    { ...auth, bodyLimit: 16_384 },
    async (request) => ({
      ok: true,
      data: { ...settings.save(request.body), datasets: geo.status() },
    }),
  );
  app.delete("/api/system/ai", auth, async () => ({
    ok: true,
    data: { ...settings.clear(), datasets: geo.status() },
  }));
  app.post(
    "/api/system/ai/test",
    { ...auth, bodyLimit: 16_384 },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { ok: true, data: await assistant.testConnection(request.body) };
    },
  );
  app.post("/api/system/ai/datasets/sync", auth, async () => ({
    ok: true,
    data: await geo.sync(),
  }));
  app.post("/api/rules/assistant", auth, async (request) => ({
    ok: true,
    data: await assistant.suggest(request.body),
  }));
}
