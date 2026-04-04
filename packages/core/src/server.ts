import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import {
  actOnBrief,
  actOnTask,
  completeSetup,
  getSetupStatus,
  getHomeOverview,
  getInbox,
  getIntakeState,
  mergePullRequestWorkflow,
  probeRepositorySetup,
  reviewPullRequestWorkflow,
  runIssueWorkflow,
  runWorkspaceSetupTest,
  submitIntakeMessage,
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

  app.get("/api/overview", async () => getHomeOverview());

  app.get("/api/inbox", async () => getInbox());

  app.get("/api/intake", async () => getIntakeState());

  app.post<{ Body: { content: string } }>("/api/intake/messages", async (request) =>
    submitIntakeMessage(request.body.content)
  );

  app.post<{ Params: { id: string }; Body: { action: "approve" | "revise" | "reject" } }>(
    "/api/briefs/:id/actions",
    async (request) => actOnBrief(Number(request.params.id), request.body.action)
  );

  app.post<{ Params: { id: string }; Body: { action: "approve" | "reject" | "resolve" } }>(
    "/api/tasks/:id/actions",
    async (request) => actOnTask(Number(request.params.id), request.body.action)
  );

  app.post("/api/sync", async () => syncProject());

  app.post<{ Params: { number: string } }>("/api/issues/:number/run", async (request) =>
    runIssueWorkflow(Number(request.params.number))
  );

  app.post<{ Params: { number: string } }>("/api/prs/:number/review", async (request) =>
    reviewPullRequestWorkflow(Number(request.params.number))
  );

  app.post<{ Params: { number: string } }>("/api/prs/:number/merge", async (request) =>
    mergePullRequestWorkflow(Number(request.params.number))
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
