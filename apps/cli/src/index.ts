#!/usr/bin/env node
import { program } from "commander";
import open from "open";

import {
  createDirectorServer,
  getConversation,
  getDirectorStatus,
  initDirector,
  listDecisions,
  pauseOrchestrator,
  resolveDecision,
  startOrchestrator,
  sendConversationMessage,
  syncProject
} from "@director-os/core";

program.name("director").description("Director OS Chief of Staff chat plus lane visibility").version("0.1.0");

program
  .command("init")
  .description("Initialize Director OS and register a project")
  .option("--project-name <name>")
  .option("--repo-path <path>")
  .option("--repo-slug <slug>")
  .option("--default-branch <branch>")
  .option("--worktree-root <path>")
  .option("--agent-runner <runner>")
  .option("--model <model>")
  .option("--skip-gh-check", "Skip gh auth validation", false)
  .option("--no-project-registration", "Only bootstrap local runtime state", false)
  .action(async (options) => {
    const result = await initDirector({
      projectName: options.projectName,
      repoPath: options.repoPath,
      repoSlug: options.repoSlug,
      defaultBranch: options.defaultBranch,
      worktreeRoot: options.worktreeRoot,
      agentRunner: options.agentRunner,
      model: options.model,
      skipGhCheck: options.skipGhCheck,
      noProjectRegistration: options.noProjectRegistration
    });

    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("serve")
  .description("Start the local API and UI server")
  .option("--port <port>", "Port to bind", "4848")
  .option("--open", "Open the browser after starting the server", false)
  .action(async (options) => {
    const app = await createDirectorServer();
    const port = Number(options.port);
    const host = "127.0.0.1";

    await app.listen({ port, host });
    const url = `http://${host}:${port}`;
    console.log(`Director OS listening on ${url}`);

    if (options.open) {
      await open(url);
    }
  });

program
  .command("start")
  .description("Start the Chief of Staff loop")
  .action(async () => {
    console.log(JSON.stringify(await startOrchestrator(), null, 2));
  });

program
  .command("pause")
  .description("Pause the Chief of Staff loop")
  .option("--reason <reason>", "Optional pause reason")
  .action(async (options) => {
    console.log(JSON.stringify(await pauseOrchestrator(options.reason), null, 2));
  });

program
  .command("status")
  .description("Print the current Chief of Staff and lane status payload")
  .action(async () => {
    console.log(JSON.stringify(await getDirectorStatus(), null, 2));
  });

program
  .command("lanes")
  .description("Print the current lane ownership view")
  .action(async () => {
    const status = await getDirectorStatus();
    console.log(JSON.stringify({
      orchestrator: status.orchestrator,
      lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
      openQuestion: status.openQuestion,
      lanes: status.lanes,
      issues: status.issues,
      openPullRequests: status.openPullRequests
    }, null, 2));
  });

program
  .command("sync")
  .description("Sync GitHub issues, PRs, comments, and checks into the local mirror")
  .action(async () => {
    const result = await syncProject();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("conversation")
  .description("Print the current Chief of Staff conversation thread")
  .action(async () => {
    console.log(JSON.stringify(await getConversation(), null, 2));
  });

program
  .command("message")
  .description("Send a message to the Chief of Staff chat")
  .argument("<content...>", "The message to send")
  .action(async (contentParts) => {
    const result = await sendConversationMessage(contentParts.join(" "));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("submit-note")
  .description("[debug] Alias for `message`")
  .argument("<content...>", "The note or product direction")
  .action(async (contentParts: string[]) => {
    const result = await sendConversationMessage(contentParts.join(" "));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("list-decisions")
  .description("[debug] View open escalation decisions")
  .action(async () => {
    console.log(JSON.stringify(await listDecisions(), null, 2));
  });

program
  .command("resolve-decision")
  .description("[debug] Resolve an escalation decision and resume work")
  .argument("<decisionId>", "Local decision id")
  .argument("<resolution...>", "Resolution text")
  .action(async (decisionId: string, resolutionParts: string[]) => {
    const result = await resolveDecision(String(decisionId), resolutionParts.join(" "));
    console.log(JSON.stringify(result, null, 2));
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
