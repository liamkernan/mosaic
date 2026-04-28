import { getEnv, LLMError, logger, RateLimitError, type ClassifiedFeedback, type FeedbackItem } from "@mosaic/core";
import { getOctokit } from "@mosaic/github-app";
import { ANTHROPIC_MODEL_IDS, LLMClient } from "@mosaic/llm";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { FeedbackClassifier } from "./classifier.js";
import { ArtifactStore } from "./artifact-store.js";
import { CodeGenerator } from "./code-generator.js";
import { decideFeedbackDisposition } from "./disposition.js";
import { IssueCreator } from "./issue-creator.js";
import { PRCreator } from "./pr-creator.js";
import { QuarantineStore } from "./quarantine.js";
import { loadRepoRuntimeConfig, type RepoRuntimeConfig } from "./repo-config.js";
import { RepoIndexer } from "./repo-indexer.js";
import {
  isFixThisCommand,
  parseStagedIssueMetadata,
  STAGED_ISSUE_LABEL,
  STAGED_ISSUE_PROMOTED_LABEL,
  type ModerateIssueMode
} from "./staged-issues.js";
import { selectGenerationModelTier, shouldEscalateClassification } from "./model-routing.js";
import { buildLlmRetryFeedbackItem, canRetryLlmOverload, getLlmRetryDelayMs, isRetryableLlmOverload } from "./transient-llm.js";
import { validate } from "./validator.js";

const FEEDBACK_QUEUE_NAME = "feedback-intake";

type RepoContext = Awaited<ReturnType<RepoIndexer["getContext"]>>;
type PromotionResult = { handled: boolean; artifactType?: "issue" | "pr"; artifactValue?: string };

export class FeedbackPipelineWorker {
  private readonly connection = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  private readonly retryQueue = new Queue<FeedbackItem>(FEEDBACK_QUEUE_NAME, { connection: this.connection });
  private readonly artifactStore = new ArtifactStore(this.connection);
  private readonly repoIndexer = new RepoIndexer();
  private readonly issueCreator = new IssueCreator();
  private readonly prCreator = new PRCreator();
  private readonly quarantineStore = new QuarantineStore();

  private normalizeFeedbackItem(feedbackItem: FeedbackItem): FeedbackItem {
    return {
      ...feedbackItem,
      receivedAt: feedbackItem.receivedAt instanceof Date
        ? feedbackItem.receivedAt
        : new Date(feedbackItem.receivedAt)
    };
  }

  private createLlmClient(mode: "byok" | "platform", apiKey: string | undefined, model: string): LLMClient {
    return new LLMClient({
      mode,
      apiKey,
      platformApiKey: process.env.ANTHROPIC_API_KEY,
      model
    });
  }

  private async postIssueComment(repoFullName: string, installationId: number, issueNumber: number, body: string): Promise<void> {
    const octokit = await getOctokit(installationId);
    const [owner, repo] = repoFullName.split("/");
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body
    });
  }

  private async addIssueLabels(repoFullName: string, installationId: number, issueNumber: number, labels: string[]): Promise<void> {
    const octokit = await getOctokit(installationId);
    const [owner, repo] = repoFullName.split("/");
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels
    });
  }

  private async canUserPromoteIssue(
    repoFullName: string,
    installationId: number,
    username: string,
    issueAuthor: string
  ): Promise<boolean> {
    if (username.toLowerCase() === issueAuthor.toLowerCase()) {
      return true;
    }

    const octokit = await getOctokit(installationId);
    const [owner, repo] = repoFullName.split("/");

    try {
      const permission = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username
      });
      return ["admin", "maintain", "write", "triage"].includes(permission.data.permission);
    } catch {
      return false;
    }
  }

  private async handleImplementationFailure(
    classifiedFeedback: ClassifiedFeedback,
    repoContext: RepoContext,
    reason: string,
    stagedIssueNumber?: number
  ): Promise<{ artifactType: "issue"; artifactValue: string }> {
    if (stagedIssueNumber) {
      await this.postIssueComment(
        classifiedFeedback.repoFullName,
        repoContext.installationId,
        stagedIssueNumber,
        `Mosaic could not promote this issue to a PR.\n\n${reason}`
      );
      return {
        artifactType: "issue",
        artifactValue: String(stagedIssueNumber)
      };
    }

    const issueNumber = await this.issueCreator.createIssue(classifiedFeedback, repoContext, { reason });
    return {
      artifactType: "issue",
      artifactValue: String(issueNumber)
    };
  }

  private async automatePullRequest(
    classifiedFeedback: ClassifiedFeedback,
    repoContext: RepoContext,
    repoConfig: RepoRuntimeConfig,
    options: {
      stagedIssueNumber?: number;
      issueMode?: ModerateIssueMode;
    } = {}
  ): Promise<{ artifactType: "issue" | "pr"; artifactValue: string }> {
    const relevantFiles = await this.repoIndexer.findRelevantFiles(repoContext, classifiedFeedback);
    const fileTree = this.repoIndexer.fileTreeToPaths(repoContext);
    const generationModel = selectGenerationModelTier(classifiedFeedback) === "sonnet"
      ? ANTHROPIC_MODEL_IDS.sonnet
      : ANTHROPIC_MODEL_IDS.haiku;
    const codeGenerator = new CodeGenerator(this.createLlmClient(repoConfig.llmKeyMode, repoConfig.llmApiKey, generationModel));

    let changes;
    try {
      changes = await codeGenerator.generate(classifiedFeedback, relevantFiles, fileTree);
    } catch (error) {
      if (error instanceof LLMError) {
        return this.handleImplementationFailure(
          classifiedFeedback,
          repoContext,
          `Code generation failed: ${error.message}`,
          options.stagedIssueNumber
        );
      }

      throw error;
    }

    if (changes.length === 0) {
      return this.handleImplementationFailure(
        classifiedFeedback,
        repoContext,
        "The code generator could not safely produce a meaningful change.",
        options.stagedIssueNumber
      );
    }

    if (changes.length > repoConfig.security.max_files_changed) {
      return this.handleImplementationFailure(
        classifiedFeedback,
        repoContext,
        `Validation failed: generated change touched ${changes.length} files which exceeds the configured limit of ${repoConfig.security.max_files_changed}.`,
        options.stagedIssueNumber
      );
    }

    const validation = await validate(changes, repoContext, {
      maxLinesAdded: repoConfig.security.max_lines_added
    });
    if (!validation.valid) {
      return this.handleImplementationFailure(
        classifiedFeedback,
        repoContext,
        `Validation failed: ${validation.errors.join("; ")}`,
        options.stagedIssueNumber
      );
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
      repoConfig,
      {
        draft: options.issueMode === "moderate-review-needed",
        linkedIssueNumber: options.stagedIssueNumber
      }
    );

    if (options.stagedIssueNumber) {
      await this.addIssueLabels(classifiedFeedback.repoFullName, repoContext.installationId, options.stagedIssueNumber, [
        STAGED_ISSUE_PROMOTED_LABEL
      ]);
      await this.postIssueComment(
        classifiedFeedback.repoFullName,
        repoContext.installationId,
        options.stagedIssueNumber,
        options.issueMode === "moderate-review-needed"
          ? `Mosaic opened a draft PR for this issue: ${prUrl}`
          : `Mosaic opened a PR for this issue: ${prUrl}`
      );
    }

    return {
      artifactType: "pr",
      artifactValue: prUrl
    };
  }

  private resolveIssueNumber(metadata: Record<string, unknown>): number | null {
    const value = metadata.issueNumber;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }

    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }

    return null;
  }

  private async tryPromoteStagedIssue(
    feedbackItem: FeedbackItem,
    repoContext: RepoContext,
    repoConfig: RepoRuntimeConfig
  ): Promise<PromotionResult> {
    if (feedbackItem.source !== "github_comment" || !isFixThisCommand(feedbackItem.rawContent)) {
      return { handled: false };
    }

    const issueNumber = this.resolveIssueNumber(feedbackItem.metadata);
    if (!issueNumber) {
      return { handled: true };
    }

    const octokit = await getOctokit(repoContext.installationId);
    const [owner, repo] = feedbackItem.repoFullName.split("/");
    const issueResponse = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber
    });
    const issue = issueResponse.data;
    const labels = issue.labels.map((label) => (typeof label === "string" ? label : label.name ?? ""));
    const stagedMetadata = parseStagedIssueMetadata(issue.body ?? "");

    if (!labels.includes(STAGED_ISSUE_LABEL) || !stagedMetadata) {
      return { handled: true, artifactType: "issue", artifactValue: String(issueNumber) };
    }

    if (labels.includes(STAGED_ISSUE_PROMOTED_LABEL)) {
      await this.postIssueComment(
        feedbackItem.repoFullName,
        repoContext.installationId,
        issueNumber,
        "Mosaic already opened a PR for this issue."
      );
      return { handled: true, artifactType: "issue", artifactValue: String(issueNumber) };
    }

    const sender = feedbackItem.senderIdentifier.trim();
    const issueAuthor = issue.user?.login ?? "";
    const authorized = sender.length > 0 && issueAuthor.length > 0
      ? await this.canUserPromoteIssue(feedbackItem.repoFullName, repoContext.installationId, sender, issueAuthor)
      : false;
    if (!authorized) {
      await this.postIssueComment(
        feedbackItem.repoFullName,
        repoContext.installationId,
        issueNumber,
        "Mosaic ignored this promotion request because it must come from the issue author or a repo collaborator with triage access or higher."
      );
      return { handled: true, artifactType: "issue", artifactValue: String(issueNumber) };
    }

    const stagedFeedback: ClassifiedFeedback = {
      id: feedbackItem.id,
      source: stagedMetadata.source,
      rawContent: stagedMetadata.rawContent,
      senderIdentifier: stagedMetadata.senderIdentifier,
      repoFullName: stagedMetadata.repoFullName,
      receivedAt: new Date(stagedMetadata.receivedAt),
      metadata: {
        ...feedbackItem.metadata,
        originalFeedbackId: stagedMetadata.feedbackId,
        stagedIssueNumber: issueNumber
      },
      category: stagedMetadata.category,
      complexity: stagedMetadata.complexity,
      summary: stagedMetadata.summary,
      relevantFiles: stagedMetadata.relevantFiles,
      confidence: stagedMetadata.confidence
    };

    const result = await this.automatePullRequest(stagedFeedback, repoContext, repoConfig, {
      stagedIssueNumber: issueNumber,
      issueMode: stagedMetadata.issueMode
    });

    return {
      handled: true,
      artifactType: result.artifactType,
      artifactValue: result.artifactValue
    };
  }

  async process(feedbackItem: FeedbackItem): Promise<void> {
    feedbackItem = this.normalizeFeedbackItem(feedbackItem);

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
    const stagedIssuePromotion = await this.tryPromoteStagedIssue(feedbackItem, repoContext, repoConfig);
    if (stagedIssuePromotion.handled) {
      if (stagedIssuePromotion.artifactType && stagedIssuePromotion.artifactValue) {
        await this.artifactStore.record({
          feedbackId: feedbackItem.id,
          repoFullName: feedbackItem.repoFullName,
          artifactType: stagedIssuePromotion.artifactType,
          artifactValue: stagedIssuePromotion.artifactValue,
          createdAt: new Date().toISOString()
        });
      }
      return;
    }

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
      const issueNumber = await this.issueCreator.createIssue(classifiedFeedback, repoContext, {
        reason: decision.reason,
        issueMode: decision.issueMode
      });
      await this.artifactStore.record({
        feedbackId: classifiedFeedback.id,
        repoFullName: classifiedFeedback.repoFullName,
        artifactType: "issue",
        artifactValue: String(issueNumber),
        createdAt: new Date().toISOString()
      });
      return;
    }

    const result = await this.automatePullRequest(classifiedFeedback, repoContext, repoConfig);
    await this.artifactStore.record({
      feedbackId: classifiedFeedback.id,
      repoFullName: classifiedFeedback.repoFullName,
      artifactType: result.artifactType,
      artifactValue: result.artifactValue,
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
