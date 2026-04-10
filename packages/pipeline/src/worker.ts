import { getEnv, logger, RateLimitError, type FeedbackItem } from "@feedbackbot/core";
import { LLMClient } from "@feedbackbot/llm";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { FeedbackClassifier } from "./classifier.js";
import { CodeGenerator } from "./code-generator.js";
import { decideFeedbackDisposition } from "./disposition.js";
import { IssueCreator } from "./issue-creator.js";
import { PRCreator } from "./pr-creator.js";
import { QuarantineStore } from "./quarantine.js";
import { loadRepoRuntimeConfig } from "./repo-config.js";
import { RepoIndexer } from "./repo-indexer.js";
import { validate } from "./validator.js";

const FEEDBACK_QUEUE_NAME = "feedback-intake";

export class FeedbackPipelineWorker {
  private readonly connection = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  private readonly retryQueue = new Queue<FeedbackItem>(FEEDBACK_QUEUE_NAME, { connection: this.connection });
  private readonly repoIndexer = new RepoIndexer();
  private readonly issueCreator = new IssueCreator();
  private readonly prCreator = new PRCreator();
  private readonly quarantineStore = new QuarantineStore();

  private createLlmClient(mode: "byok" | "platform", apiKey?: string): LLMClient {
    return new LLMClient({
      mode,
      apiKey,
      platformApiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async process(feedbackItem: FeedbackItem): Promise<void> {
    const repoContext = await this.repoIndexer.getContext(feedbackItem.repoFullName);
    const repoConfig = await loadRepoRuntimeConfig(repoContext.localPath, feedbackItem.repoFullName);
    const llmClient = this.createLlmClient(repoConfig.llmKeyMode, repoConfig.llmApiKey);
    const classifier = new FeedbackClassifier(llmClient);
    const codeGenerator = new CodeGenerator(llmClient);
    const topLevelFileTree = repoContext.fileTree.map((node) => node.path);
    const classifiedFeedback = await classifier.classify(feedbackItem, topLevelFileTree);
    const decision = decideFeedbackDisposition(classifiedFeedback, repoConfig);

    if (decision.disposition === "quarantine") {
      await this.quarantineStore.quarantine(classifiedFeedback, decision.reason);
      return;
    }

    if (decision.disposition === "issue") {
      await this.issueCreator.createIssue(classifiedFeedback, repoContext, decision.reason);
      return;
    }

    const relevantFiles = await this.repoIndexer.findRelevantFiles(repoContext, classifiedFeedback);
    const fileTree = this.repoIndexer.fileTreeToPaths(repoContext);
    const changes = await codeGenerator.generate(classifiedFeedback, relevantFiles, fileTree);

    if (changes.length === 0) {
      await this.issueCreator.createIssue(
        classifiedFeedback,
        repoContext,
        "The code generator could not safely produce a meaningful change."
      );
      return;
    }

    if (changes.length > repoConfig.security.max_files_changed) {
      await this.issueCreator.createIssue(
        classifiedFeedback,
        repoContext,
        `Validation failed: generated change touched ${changes.length} files which exceeds the configured limit of ${repoConfig.security.max_files_changed}.`
      );
      return;
    }

    const validation = await validate(changes, repoContext, {
      maxLinesAdded: repoConfig.security.max_lines_added
    });
    if (!validation.valid) {
      await this.issueCreator.createIssue(
        classifiedFeedback,
        repoContext,
        `Validation failed: ${validation.errors.join("; ")}`
      );
      return;
    }

    await this.prCreator.createPR(
      {
        repoFullName: classifiedFeedback.repoFullName,
        branchName: "",
        title: "",
        body: "",
        changes,
        feedbackItem: classifiedFeedback
      },
      repoContext,
      repoConfig
    );
  }

  createWorker(): Worker<FeedbackItem> {
    return new Worker<FeedbackItem>(
      FEEDBACK_QUEUE_NAME,
      async (job) => {
        try {
          await this.process(job.data);
        } catch (error) {
          if (error instanceof RateLimitError) {
            await this.retryQueue.add("feedback-item", job.data, {
              delay: 60_000,
              attempts: 3,
              backoff: {
                type: "exponential",
                delay: 1_000
              }
            });
            logger.warn({ repo: job.data.repoFullName }, "Rate limit hit, re-queued feedback job");
            return;
          }

          throw error;
        }
      },
      {
        connection: this.connection,
        concurrency: getEnv().WORKER_CONCURRENCY
      }
    );
  }
}
