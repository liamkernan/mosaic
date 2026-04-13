import { getEnv, LLMError, logger, RateLimitError, type FeedbackItem } from "@feedbackbot/core";
import { ANTHROPIC_MODEL_IDS, LLMClient } from "@feedbackbot/llm";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { FeedbackClassifier } from "./classifier.js";
import { ArtifactStore } from "./artifact-store.js";
import { CodeGenerator } from "./code-generator.js";
import { decideFeedbackDisposition } from "./disposition.js";
import { IssueCreator } from "./issue-creator.js";
import { PRCreator } from "./pr-creator.js";
import { QuarantineStore } from "./quarantine.js";
import { loadRepoRuntimeConfig } from "./repo-config.js";
import { RepoIndexer } from "./repo-indexer.js";
import { selectGenerationModelTier, shouldEscalateClassification } from "./model-routing.js";
import { buildLlmRetryFeedbackItem, canRetryLlmOverload, getLlmRetryDelayMs, isRetryableLlmOverload } from "./transient-llm.js";
import { validate } from "./validator.js";

const FEEDBACK_QUEUE_NAME = "feedback-intake";

export class FeedbackPipelineWorker {
  private readonly connection = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  private readonly retryQueue = new Queue<FeedbackItem>(FEEDBACK_QUEUE_NAME, { connection: this.connection });
  private readonly artifactStore = new ArtifactStore(this.connection);
  private readonly repoIndexer = new RepoIndexer();
  private readonly issueCreator = new IssueCreator();
  private readonly prCreator = new PRCreator();
  private readonly quarantineStore = new QuarantineStore();

  private createLlmClient(mode: "byok" | "platform", apiKey: string | undefined, model: string): LLMClient {
    return new LLMClient({
      mode,
      apiKey,
      platformApiKey: process.env.ANTHROPIC_API_KEY,
      model
    });
  }

  async process(feedbackItem: FeedbackItem): Promise<void> {
    const existingArtifact = await this.artifactStore.get(feedbackItem.id);
    if (existingArtifact) {
      logger.warn(
        { feedbackId: feedbackItem.id, artifactType: existingArtifact.artifactType, artifactValue: existingArtifact.artifactValue },
        "Feedback already produced an artifact, skipping duplicate processing"
      );
      return;
    }

    const repoContext = await this.repoIndexer.getContext(feedbackItem.repoFullName);
    const repoConfig = await loadRepoRuntimeConfig(repoContext.localPath, feedbackItem.repoFullName);
    const haikuClient = this.createLlmClient(repoConfig.llmKeyMode, repoConfig.llmApiKey, ANTHROPIC_MODEL_IDS.haiku);
    const sonnetClient = this.createLlmClient(repoConfig.llmKeyMode, repoConfig.llmApiKey, ANTHROPIC_MODEL_IDS.sonnet);
    const classifier = new FeedbackClassifier(haikuClient);
    const topLevelFileTree = repoContext.fileTree.map((node) => node.path);
    let classifiedFeedback = await classifier.classify(feedbackItem, topLevelFileTree);
    if (shouldEscalateClassification(classifiedFeedback)) {
      classifiedFeedback = await new FeedbackClassifier(sonnetClient).classify(feedbackItem, topLevelFileTree);
    }
    const decision = decideFeedbackDisposition(classifiedFeedback, repoConfig);

    if (decision.disposition === "quarantine") {
      await this.quarantineStore.quarantine(classifiedFeedback, decision.reason);
      await this.artifactStore.record({
        feedbackId: classifiedFeedback.id,
        repoFullName: classifiedFeedback.repoFullName,
        artifactType: "quarantine",
        artifactValue: decision.reason,
        createdAt: new Date().toISOString()
      });
      return;
    }

    if (decision.disposition === "issue") {
      const issueNumber = await this.issueCreator.createIssue(classifiedFeedback, repoContext, decision.reason);
      await this.artifactStore.record({
        feedbackId: classifiedFeedback.id,
        repoFullName: classifiedFeedback.repoFullName,
        artifactType: "issue",
        artifactValue: String(issueNumber),
        createdAt: new Date().toISOString()
      });
      return;
    }

    const relevantFiles = await this.repoIndexer.findRelevantFiles(repoContext, classifiedFeedback);
    const fileTree = this.repoIndexer.fileTreeToPaths(repoContext);
    const generationClient = selectGenerationModelTier(classifiedFeedback) === "sonnet" ? sonnetClient : haikuClient;
    const codeGenerator = new CodeGenerator(generationClient);
    let changes;
    try {
      changes = await codeGenerator.generate(classifiedFeedback, relevantFiles, fileTree);
    } catch (error) {
      if (error instanceof LLMError) {
        const issueNumber = await this.issueCreator.createIssue(
          classifiedFeedback,
          repoContext,
          `Code generation failed: ${error.message}`
        );
        await this.artifactStore.record({
          feedbackId: classifiedFeedback.id,
          repoFullName: classifiedFeedback.repoFullName,
          artifactType: "issue",
          artifactValue: String(issueNumber),
          createdAt: new Date().toISOString()
        });
        return;
      }

      throw error;
    }

    if (changes.length === 0) {
      const issueNumber = await this.issueCreator.createIssue(
        classifiedFeedback,
        repoContext,
        "The code generator could not safely produce a meaningful change."
      );
      await this.artifactStore.record({
        feedbackId: classifiedFeedback.id,
        repoFullName: classifiedFeedback.repoFullName,
        artifactType: "issue",
        artifactValue: String(issueNumber),
        createdAt: new Date().toISOString()
      });
      return;
    }

    if (changes.length > repoConfig.security.max_files_changed) {
      const issueNumber = await this.issueCreator.createIssue(
        classifiedFeedback,
        repoContext,
        `Validation failed: generated change touched ${changes.length} files which exceeds the configured limit of ${repoConfig.security.max_files_changed}.`
      );
      await this.artifactStore.record({
        feedbackId: classifiedFeedback.id,
        repoFullName: classifiedFeedback.repoFullName,
        artifactType: "issue",
        artifactValue: String(issueNumber),
        createdAt: new Date().toISOString()
      });
      return;
    }

    const validation = await validate(changes, repoContext, {
      maxLinesAdded: repoConfig.security.max_lines_added
    });
    if (!validation.valid) {
      const issueNumber = await this.issueCreator.createIssue(
        classifiedFeedback,
        repoContext,
        `Validation failed: ${validation.errors.join("; ")}`
      );
      await this.artifactStore.record({
        feedbackId: classifiedFeedback.id,
        repoFullName: classifiedFeedback.repoFullName,
        artifactType: "issue",
        artifactValue: String(issueNumber),
        createdAt: new Date().toISOString()
      });
      return;
    }

    const prUrl = await this.prCreator.createPR(
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
    await this.artifactStore.record({
      feedbackId: classifiedFeedback.id,
      repoFullName: classifiedFeedback.repoFullName,
      artifactType: "pr",
      artifactValue: prUrl,
      createdAt: new Date().toISOString()
    });
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

          if (isRetryableLlmOverload(error) && canRetryLlmOverload(job.data)) {
            const retriedJob = buildLlmRetryFeedbackItem(job.data);
            const delay = getLlmRetryDelayMs(job.data);

            await this.retryQueue.add("feedback-item", retriedJob, {
              delay,
              attempts: 1
            });
            logger.warn(
              { repo: job.data.repoFullName, feedbackId: job.data.id, retryCount: retriedJob.metadata.__llmRetryCount, delay },
              "Transient LLM overload, re-queued feedback job"
            );
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
