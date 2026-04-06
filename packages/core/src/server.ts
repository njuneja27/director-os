import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import {
  completeSetup,
  getConversation,
  getDirectorStatus,
  getSetupStatus,
  pauseOrchestrator,
  probeRepositorySetup,
  resetRouterRuntime,
  runWorkspaceSetupTest,
  startOrchestrator,
  sendConversationMessage,
  syncProject,
  updateProjectSettings
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
  app.get("/api/conversation", async () => getConversation());

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
  app.post<{ Body: { content: string } }>("/api/conversation", async (request) =>
    sendConversationMessage(request.body.content)
  );

  app.post("/api/start", async () => startOrchestrator());
  app.post<{ Body: { reason?: string } }>("/api/pause", async (request) =>
    pauseOrchestrator(request.body?.reason)
  );
  app.post("/api/sync", async () => syncProject());
  app.post<{
    Body: {
      repoPath: string;
      repoSlug: string;
      defaultBranch: string;
      defaultBranchStrategy: "repo_default" | "custom";
      worktreeRoot: string;
      model: string;
    };
  }>("/api/project/settings", async (request) => updateProjectSettings(request.body));
  app.post("/api/reset-router-runtime", async () => resetRouterRuntime());

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
