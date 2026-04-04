import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import {
  completeSetup,
  getDirectorStatus,
  getSetupStatus,
  listDecisions,
  pauseOrchestrator,
  probeRepositorySetup,
  resolveDecision,
  runWorkspaceSetupTest,
  startOrchestrator,
  submitDirectorNote,
  syncProject
} from "./services.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(currentDir, "../../../apps/web/dist");

export async function createDirectorServer() {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: true
  });

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/"
  });

  app.get("/api/health", async () => ({
    ok: true
  }));

  app.get("/api/setup/status", async () => getSetupStatus());

  app.post<{
    Body: {
      repoPath: string;
      projectName?: string;
      worktreeRoot?: string;
      model?: string;
    };
  }>("/api/setup/probe-repository", async (request) => probeRepositorySetup(request.body));

  app.post<{
    Body: {
      repositoryDraft: {
        repoPath: string;
        projectName: string;
        repoSlug: string;
        defaultBranch: string;
        worktreeRoot: string;
        agentRunner: string;
        model: string;
      };
    };
  }>("/api/setup/run-workspace-test", async (request) =>
    runWorkspaceSetupTest(request.body.repositoryDraft)
  );

  app.post<{
    Body: {
      repositoryDraft: {
        repoPath: string;
        projectName: string;
        repoSlug: string;
        defaultBranch: string;
        worktreeRoot: string;
        agentRunner: string;
        model: string;
      };
    };
  }>("/api/setup/complete", async (request) => completeSetup(request.body.repositoryDraft));

  app.get("/api/status", async () => getDirectorStatus());
  app.get("/api/decisions", async () => listDecisions());

  app.post("/api/start", async () => startOrchestrator());
  app.post<{ Body: { reason?: string } }>("/api/pause", async (request) =>
    pauseOrchestrator(request.body?.reason)
  );
  app.post("/api/sync", async () => syncProject());
  app.post<{ Body: { content: string } }>("/api/notes", async (request) =>
    submitDirectorNote(request.body.content)
  );
  app.post<{ Params: { id: string }; Body: { resolution: string } }>(
    "/api/decisions/:id/resolve",
    async (request) => resolveDecision(Number(request.params.id), request.body.resolution)
  );

  app.setNotFoundHandler(async (request, reply) => {
    if (request.raw.url?.startsWith("/api/")) {
      return reply.code(404).send({
        error: "Not Found"
      });
    }

    return reply.sendFile("index.html");
  });

  return app;
}
