#!/usr/bin/env node
import { program } from "commander";
import open from "open";

import {
  actOnBrief,
  createDirectorServer,
  getHomeOverview,
  getInbox,
  getIntakeState,
  initDirector,
  mergePullRequestWorkflow,
  reviewPullRequestWorkflow,
  runIssueWorkflow,
  submitIntakeMessage,
  syncProject
} from "@director-os/core";

program.name("director").description("Director OS local control plane").version("0.1.0");

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
      noProjectRegistration: options.projectRegistration === false
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
  .command("sync")
  .description("Sync GitHub issues, PRs, comments, and checks into the local mirror")
  .action(async () => {
    const result = await syncProject();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("intake")
  .description("Submit a product goal to the chief of staff intake flow")
  .argument("<message...>", "The product direction or problem statement")
  .action(async (messageParts) => {
    const result = await submitIntakeMessage(messageParts.join(" "));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("approve-brief")
  .description("Approve a brief and decompose it into a GitHub epic and child issues")
  .argument("<briefId>", "Local brief id")
  .action(async (briefId) => {
    const result = await actOnBrief(Number(briefId), "approve");
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("run-issue")
  .description("Execute a ready issue inside a local git worktree")
  .argument("<issueNumber>", "GitHub issue number")
  .action(async (issueNumber) => {
    const result = await runIssueWorkflow(Number(issueNumber));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("review-pr")
  .description("Run the independent review agent on a GitHub pull request")
  .argument("<prNumber>", "GitHub pull request number")
  .action(async (prNumber) => {
    const result = await reviewPullRequestWorkflow(Number(prNumber));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("merge-pr")
  .description("Merge a pull request after review and passing checks")
  .argument("<prNumber>", "GitHub pull request number")
  .action(async (prNumber) => {
    await mergePullRequestWorkflow(Number(prNumber));
    console.log(JSON.stringify({ ok: true, prNumber: Number(prNumber) }, null, 2));
  });

program
  .command("overview")
  .description("Print the home overview payload")
  .action(async () => {
    console.log(JSON.stringify(await getHomeOverview(), null, 2));
  });

program
  .command("inbox")
  .description("Print the inbox payload")
  .action(async () => {
    console.log(JSON.stringify(await getInbox(), null, 2));
  });

program
  .command("intake-state")
  .description("Print the latest intake state")
  .action(async () => {
    console.log(JSON.stringify(await getIntakeState(), null, 2));
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
