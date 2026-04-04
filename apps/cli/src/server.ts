import { fileURLToPath } from "node:url";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { DirectorOs } from "@director-os/core";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const webDist = path.resolve(currentDir, "../../web/dist");

type BodyWithDecision = {
  decision: "approve" | "reject" | "revise" | "resolve";
  note?: string;
};

export async function createServer() {
  const app = Fastify({
    logger: true
  });

  app.register(fastifyStatic, {
    root: webDist,
    prefix: "/"
  });

  app.get("/api/project", async () => {
    const director = await DirectorOs.create();
    try {
      return {
        project: await director.getActiveProject()
      };
    } finally {
      await director.close();
    }
  });

  app.get("/api/home", async () => {
    const director = await DirectorOs.create();
    try {
      return director.getHomeSnapshot();
    } finally {
      await director.close();
    }
  });

  app.get("/api/inbox", async () => {
    const director = await DirectorOs.create();
    try {
      const snapshot = await director.getHomeSnapshot();
      return {
        currentBrief: snapshot.currentBrief,
        tasks: snapshot.directorTasks
      };
    } finally {
      await director.close();
    }
  });

  app.get("/api/intake", async () => {
    const director = await DirectorOs.create();
    try {
      const snapshot = await director.getHomeSnapshot();
      return {
        currentBrief: snapshot.currentBrief
      };
    } finally {
      await director.close();
    }
  });

  app.post<{ Body: { content: string } }>("/api/intake/messages", async (request) => {
    const director = await DirectorOs.create();
    try {
      return director.createIntakeMessage({
        content: request.body.content
      });
    } finally {
      await director.close();
    }
  });

  app.post<{ Params: { briefId: string }; Body: BodyWithDecision }>("/api/briefs/:briefId/decision", async (request) => {
    const director = await DirectorOs.create();
    try {
      return director.decideBrief({
        briefId: request.params.briefId,
        decision: request.body.decision,
        note: request.body.note
      });
    } finally {
      await director.close();
    }
  });

  app.post<{ Params: { taskId: string }; Body: BodyWithDecision }>("/api/tasks/:taskId/decision", async (request) => {
    const director = await DirectorOs.create();
    try {
      return director.decideTask({
        taskId: request.params.taskId,
        decision: request.body.decision,
        note: request.body.note
      });
    } finally {
      await director.close();
    }
  });

  app.post("/api/sync", async () => {
    const director = await DirectorOs.create();
    try {
      return {
        items: await director.sync()
      };
    } finally {
      await director.close();
    }
  });

  app.post<{ Body: { issueNumber: number } }>("/api/run-issue", async (request) => {
    const director = await DirectorOs.create();
    try {
      return director.runIssue({
        issueNumber: request.body.issueNumber
      });
    } finally {
      await director.close();
    }
  });

  app.post<{ Body: { pullRequestNumber: number } }>("/api/review-pr", async (request) => {
    const director = await DirectorOs.create();
    try {
      return director.reviewPullRequest({
        pullRequestNumber: request.body.pullRequestNumber
      });
    } finally {
      await director.close();
    }
  });

  app.post<{ Body: { pullRequestNumber: number } }>("/api/merge-pr", async (request) => {
    const director = await DirectorOs.create();
    try {
      await director.mergePullRequest({
        pullRequestNumber: request.body.pullRequestNumber
      });
      return { ok: true };
    } finally {
      await director.close();
    }
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  return app;
}
