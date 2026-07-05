import { getEnv, LLMError, logger, RateLimitError, type ClassifiedFeedback, type FeedbackItem, type GeneratedChange, type LLMProvider } from "@mosaic/core";
import { getOctokit } from "@mosaic/github-app";
import {
  ANTHROPIC_ADVISOR_MAX_TOKENS,
  ANTHROPIC_ADVISOR_MODEL_ID,
  ANTHROPIC_MODEL_IDS,
  LLMClient,
  OPENAI_MODEL_IDS,
  type AdvisorToolOptions,
  type OpenAIReasoningEffort
} from "@mosaic/llm";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { FeedbackClassifier } from "./classifier.js";
import { ArtifactStore } from "./artifact-store.js";
import { mergeGeneratedChanges } from "./change-set.js";
import { CodeGenerator, scopeValidationPattern } from "./code-generator.js";
import { decideFeedbackDisposition } from "./disposition.js";
import { ImplementationPlanner, type ImplementationPlan } from "./implementation-planner.js";
import { IssueCreator } from "./issue-creator.js";
import { PRCreator } from "./pr-creator.js";
import { QuarantineStore } from "./quarantine.js";
import { loadRepoRuntimeConfig, type RepoRuntimeConfig } from "./repo-config.js";
import { RepoIndexer } from "./repo-indexer.js";
import {
  isFixThisCommand,
  getModerateIssueMode,
  parseStagedIssueMetadata,
  STAGED_ISSUE_LABEL,
  STAGED_ISSUE_PROMOTED_LABEL,
  type StagedIssueMode
} from "./staged-issues.js";
import { selectGenerationModelTier, selectOpenAIModel, selectPlanningModelTier, shouldEscalateClassification, shouldUseAdvisorTool } from "./model-routing.js";
import { pruneChangesToPlanScope, validatePlanCompletion } from "./plan-completion-validator.js";
import { assessRepairProgress } from "./repair-progress.js";
import { buildLlmRetryFeedbackItem, canRetryLlmOverload, getLlmRetryDelayMs, isRetryableLlmOverload } from "./transient-llm.js";
import { validate } from "./validator.js";
import { applyValidationFallbacks, applyVerificationFallbacks } from "./validation-repair.js";
import { runVerificationCommands } from "./verification-runner.js";

const FEEDBACK_QUEUE_NAME = "feedback-intake";
const VALIDATION_RECOVERY_ATTEMPTS = 3;
const oversizedPatchPattern = /too large|exceeds limit|total new code added/i;

type RepoContext = Awaited<ReturnType<RepoIndexer["getContext"]>>;
type PromotionResult = { handled: boolean; reason?: string; artifactType?: "issue" | "pr"; artifactValue?: string };
type LlmClientFactory = (options: ConstructorParameters<typeof LLMClient>[0]) => LLMClient;

export interface FeedbackPipelineWorkerDependencies {
  connection?: Redis;
  retryQueue?: Pick<Queue<FeedbackItem>, "add">;
  artifactStore?: Pick<ArtifactStore, "get" | "record">;
  repoIndexer?: Pick<
    RepoIndexer,
    "getContext" | "fileTreeToPaths" | "findRelevantFiles" | "findRepositoryReferenceFiles" | "readFiles"
  >;
  issueCreator?: Pick<IssueCreator, "createIssue">;
  prCreator?: Pick<PRCreator, "createPR">;
  quarantineStore?: Pick<QuarantineStore, "quarantine">;
  loadRepoRuntimeConfig?: typeof loadRepoRuntimeConfig;
  decideFeedbackDisposition?: typeof decideFeedbackDisposition;
  createLlmClient?: LlmClientFactory;
}

export interface FeedbackJobResult {
  outcome: "succeeded" | "requeued";
  reason: string;
}

function shouldUseImplementationPlanning(issueMode: StagedIssueMode | undefined): boolean {
  return issueMode === "moderate-review-needed" || issueMode === "complex-review-needed";
}

function mergeRelevantFiles(existingFiles: Array<{ path: string; content: string; reason: string }>, plannedFiles: Array<{ path: string; content: string; reason: string }>) {
  const merged = new Map(existingFiles.map((file) => [file.path, file]));

  for (const file of plannedFiles) {
    merged.set(file.path, file);
  }

  return [...merged.values()];
}

function stripMosaicMetadataComments(body: string): string {
  return body.replace(/<!--\s*mosaic:staged-issue[\s\S]*?-->/g, "").trim();
}

async function validateGeneratedChanges(
  changes: GeneratedChange[],
  repoContext: RepoContext,
  repoConfig: RepoRuntimeConfig,
  implementationPlan: ImplementationPlan | undefined,
  feedbackText = ""
) {
  const validation = await validate(changes, repoContext, {
    maxLinesAdded: repoConfig.security.max_lines_added,
    maxChangedLines: repoConfig.security.max_changed_lines,
    blockPatterns: repoConfig.security.block_patterns
  });
  const planValidationErrors = validatePlanCompletion(changes, implementationPlan, feedbackText);
  return planValidationErrors.length > 0
    ? {
        valid: false,
        errors: [...validation.errors, ...planValidationErrors]
      }
    : validation;
}

export class FeedbackPipelineWorker {
  private connection: Redis | undefined;
  private retryQueue: Pick<Queue<FeedbackItem>, "add"> | undefined;
  private readonly artifactStore: Pick<ArtifactStore, "get" | "record">;
  private readonly repoIndexer: Pick<
    RepoIndexer,
    "getContext" | "fileTreeToPaths" | "findRelevantFiles" | "findRepositoryReferenceFiles" | "readFiles"
  >;
  private readonly issueCreator: Pick<IssueCreator, "createIssue">;
  private readonly prCreator: Pick<PRCreator, "createPR">;
  private readonly quarantineStore: Pick<QuarantineStore, "quarantine">;
  private readonly runtimeConfigLoader: typeof loadRepoRuntimeConfig;
  private readonly dispositionDecider: typeof decideFeedbackDisposition;
  private readonly llmClientFactory: LlmClientFactory;

  constructor(dependencies: FeedbackPipelineWorkerDependencies = {}) {
    this.connection = dependencies.connection;
    this.retryQueue = dependencies.retryQueue;
    this.artifactStore = dependencies.artifactStore ?? new ArtifactStore(this.getConnection());
    this.repoIndexer = dependencies.repoIndexer ?? new RepoIndexer();
    this.issueCreator = dependencies.issueCreator ?? new IssueCreator();
    this.prCreator = dependencies.prCreator ?? new PRCreator();
    this.quarantineStore = dependencies.quarantineStore ?? new QuarantineStore();
    this.runtimeConfigLoader = dependencies.loadRepoRuntimeConfig ?? loadRepoRuntimeConfig;
    this.dispositionDecider = dependencies.decideFeedbackDisposition ?? decideFeedbackDisposition;
    this.llmClientFactory = dependencies.createLlmClient ?? ((options) => new LLMClient(options));
  }

  private getConnection(): Redis {
    this.connection ??= new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    return this.connection;
  }

  private getRetryQueue(): Pick<Queue<FeedbackItem>, "add"> {
    this.retryQueue ??= new Queue<FeedbackItem>(FEEDBACK_QUEUE_NAME, { connection: this.getConnection() });
    return this.retryQueue;
  }

  private normalizeFeedbackItem(feedbackItem: FeedbackItem): FeedbackItem {
    return {
      ...feedbackItem,
      receivedAt: feedbackItem.receivedAt instanceof Date
        ? feedbackItem.receivedAt
        : new Date(feedbackItem.receivedAt)
    };
  }

  private createLlmClient(
    provider: LLMProvider,
    mode: "byok" | "platform",
    apiKey: string | undefined,
    model: string,
    reasoningEffort?: OpenAIReasoningEffort,
    advisorTool?: AdvisorToolOptions
  ): LLMClient {
    const env = getEnv();
    return this.llmClientFactory({
      provider,
      mode,
      apiKey,
      platformApiKey: provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY,
      model,
      reasoningEffort,
      advisorTool: provider === "anthropic" ? advisorTool : undefined
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
  ): Promise<{ artifactType: "issue"; artifactValue: string; reason: string }> {
    if (stagedIssueNumber) {
      await this.postIssueComment(
        classifiedFeedback.repoFullName,
        repoContext.installationId,
        stagedIssueNumber,
        `Mosaic could not promote this issue to a PR.\n\n${reason}`
      );
      return {
        artifactType: "issue",
        artifactValue: String(stagedIssueNumber),
        reason: `Kept staged issue #${stagedIssueNumber} because ${reason}`
      };
    }

    const issueNumber = await this.issueCreator.createIssue(classifiedFeedback, repoContext, { reason });
    return {
      artifactType: "issue",
      artifactValue: String(issueNumber),
      reason: `Created issue #${issueNumber} because ${reason}`
    };
  }

  private async automatePullRequest(
    classifiedFeedback: ClassifiedFeedback,
    repoContext: RepoContext,
    repoConfig: RepoRuntimeConfig,
    options: {
      stagedIssueNumber?: number;
      issueMode?: StagedIssueMode;
    } = {}
  ): Promise<{ artifactType: "issue" | "pr"; artifactValue: string; reason: string }> {
    const fileTree = this.repoIndexer.fileTreeToPaths(repoContext);
    const [classifierFiles, referenceFiles] = await Promise.all([
      this.repoIndexer.findRelevantFiles(repoContext, classifiedFeedback),
      this.repoIndexer.findRepositoryReferenceFiles(repoContext, classifiedFeedback, {
        issueNumber: options.stagedIssueNumber
      })
    ]);
    let relevantFiles = mergeRelevantFiles(classifierFiles, referenceFiles);
    const openAISelection = repoConfig.llmProvider === "openai"
      ? selectOpenAIModel(classifiedFeedback, repoConfig.llmModelPreset, options.issueMode)
      : undefined;
    const generationModel = openAISelection?.model ??
      ANTHROPIC_MODEL_IDS[selectGenerationModelTier(classifiedFeedback, repoConfig.llmModelPreset)];
    const advisorTool = repoConfig.llmProvider === "anthropic" && shouldUseAdvisorTool(classifiedFeedback, repoConfig.llmModelPreset)
      ? {
          model: ANTHROPIC_ADVISOR_MODEL_ID,
          maxUses: 1,
          maxTokens: ANTHROPIC_ADVISOR_MAX_TOKENS
      }
      : undefined;
    const codeGenerator = new CodeGenerator(this.createLlmClient(
      repoConfig.llmProvider,
      repoConfig.llmKeyMode,
      repoConfig.llmApiKey,
      generationModel,
      openAISelection?.reasoningEffort,
      advisorTool
    ));
    const completeSolution = shouldUseImplementationPlanning(options.issueMode);
    let implementationPlan: ImplementationPlan | undefined;
    const feedbackText = `${classifiedFeedback.summary}\n${classifiedFeedback.rawContent}`;

    if (completeSolution) {
      const planningModel = openAISelection?.model ??
        ANTHROPIC_MODEL_IDS[selectPlanningModelTier(classifiedFeedback, repoConfig.llmModelPreset)];
      const planner = new ImplementationPlanner(this.createLlmClient(
        repoConfig.llmProvider,
        repoConfig.llmKeyMode,
        repoConfig.llmApiKey,
        planningModel,
        openAISelection?.reasoningEffort,
        advisorTool
      ));
      implementationPlan = await planner.plan(classifiedFeedback, relevantFiles, fileTree);
      const loadedPaths = new Set(relevantFiles.map((file) => file.path));
      const plannedFiles = await this.repoIndexer.readFiles(
        repoContext,
        implementationPlan.requiredFiles.filter((file) => !loadedPaths.has(file.path))
      );
      relevantFiles = mergeRelevantFiles(relevantFiles, plannedFiles);
    }

    let changes: GeneratedChange[];
    try {
      changes = await codeGenerator.generate(classifiedFeedback, relevantFiles, fileTree, implementationPlan, {
        completeSolution
      });
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

    let validation = await validateGeneratedChanges(changes, repoContext, repoConfig, implementationPlan, feedbackText);

    for (let attempt = 0; !validation.valid && attempt < VALIDATION_RECOVERY_ATTEMPTS; attempt += 1) {
      if (validation.errors.some((error) => scopeValidationPattern.test(error))) {
        const scopedChanges = pruneChangesToPlanScope(changes, implementationPlan, feedbackText);
        if (scopedChanges.length > 0 && scopedChanges.length < changes.length) {
          changes = scopedChanges;
          validation = await validateGeneratedChanges(changes, repoContext, repoConfig, implementationPlan, feedbackText);
          if (validation.valid) {
            break;
          }
        }
      }

      let madeProgress = false;
      try {
        const repairedChanges = await codeGenerator.repairValidationFailure(
          classifiedFeedback,
          relevantFiles,
          fileTree,
          changes,
          validation.errors,
          implementationPlan,
          {
            completeSolution
          }
        );

        const candidateChanges = validation.errors.some((error) => oversizedPatchPattern.test(error) || scopeValidationPattern.test(error))
          ? repairedChanges
          : mergeGeneratedChanges(changes, repairedChanges);
        if (repairedChanges.length > 0 && candidateChanges.length <= repoConfig.security.max_files_changed) {
          const candidateValidation = await validateGeneratedChanges(
            candidateChanges,
            repoContext,
            repoConfig,
            implementationPlan,
            feedbackText
          );
          const progress = assessRepairProgress(changes, candidateChanges, validation.errors, candidateValidation.errors, {
            plannedFiles: implementationPlan?.requiredFiles.map((file) => file.path)
          });
          logger.info({ repairProgress: progress, feedbackId: classifiedFeedback.id }, "Assessed validation repair progress");
          if (progress.accepted) {
            changes = candidateChanges;
            madeProgress = true;
            validation = candidateValidation;
          }
        }
      } catch (error) {
        if (!(error instanceof LLMError)) {
          throw error;
        }
      }

      if (!validation.valid) {
        const completedChanges = await applyValidationFallbacks(changes, repoContext, validation.errors);
        if (completedChanges !== changes && completedChanges.length <= repoConfig.security.max_files_changed) {
          const completedValidation = await validateGeneratedChanges(
            completedChanges,
            repoContext,
            repoConfig,
            implementationPlan,
            feedbackText
          );
          const progress = assessRepairProgress(changes, completedChanges, validation.errors, completedValidation.errors, {
            plannedFiles: implementationPlan?.requiredFiles.map((file) => file.path)
          });
          logger.info({ repairProgress: progress, feedbackId: classifiedFeedback.id }, "Assessed deterministic repair progress");
          if (progress.accepted) {
            changes = completedChanges;
            madeProgress = true;
            validation = completedValidation;
          }
        }
      }

      if (!madeProgress) {
        break;
      }
    }

    if (!validation.valid) {
      return this.handleImplementationFailure(
        classifiedFeedback,
        repoContext,
        `Validation failed: ${validation.errors.join("; ")}`,
        options.stagedIssueNumber
      );
    }

    let verification = await runVerificationCommands(changes, repoContext, implementationPlan);
    if (!verification.valid) {
      const completedChanges = applyVerificationFallbacks(changes, verification.errors);
      if (completedChanges && completedChanges.length <= repoConfig.security.max_files_changed) {
        const completedValidation = await validateGeneratedChanges(
          completedChanges,
          repoContext,
          repoConfig,
          implementationPlan,
          feedbackText
        );
        if (completedValidation.valid) {
          const completedVerification = await runVerificationCommands(completedChanges, repoContext, implementationPlan);
          const progress = assessRepairProgress(changes, completedChanges, verification.errors, completedVerification.errors, {
            plannedFiles: implementationPlan?.requiredFiles.map((file) => file.path)
          });
          logger.info({ repairProgress: progress, feedbackId: classifiedFeedback.id }, "Assessed deterministic verification repair progress");
          if (progress.accepted) {
            changes = completedChanges;
            validation = completedValidation;
            verification = completedVerification;
          }
        }
      }
    }

    if (!verification.valid) {
      try {
        const repairedChanges = await codeGenerator.repairValidationFailure(
          classifiedFeedback,
          relevantFiles,
          fileTree,
          changes,
          verification.errors,
          implementationPlan,
          {
            completeSolution
          }
        );

        const candidateChanges = mergeGeneratedChanges(changes, repairedChanges);
        if (repairedChanges.length > 0 && candidateChanges.length <= repoConfig.security.max_files_changed) {
          const completeRepairedValidation = await validateGeneratedChanges(candidateChanges, repoContext, repoConfig, implementationPlan, feedbackText);

          if (completeRepairedValidation.valid) {
            const repairedVerification = await runVerificationCommands(candidateChanges, repoContext, implementationPlan);
            const progress = assessRepairProgress(changes, candidateChanges, verification.errors, repairedVerification.errors, {
              plannedFiles: implementationPlan?.requiredFiles.map((file) => file.path)
            });
            logger.info({ repairProgress: progress, feedbackId: classifiedFeedback.id }, "Assessed verification repair progress");
            if (progress.accepted) {
              changes = candidateChanges;
              validation = completeRepairedValidation;
              verification = repairedVerification;
            }
          }
        }
      } catch (error) {
        if (!(error instanceof LLMError)) {
          throw error;
        }
      }
    }

    if (!verification.valid) {
      return this.handleImplementationFailure(
        classifiedFeedback,
        repoContext,
        `Verification failed: ${verification.errors.join("; ")}`,
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
        draft: options.issueMode === "moderate-review-needed" || options.issueMode === "complex-review-needed",
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
        options.issueMode === "moderate-review-needed" || options.issueMode === "complex-review-needed"
          ? `Mosaic opened a draft PR for this issue: ${prUrl}`
          : `Mosaic opened a PR for this issue: ${prUrl}`
      );
    }

    return {
      artifactType: "pr",
      artifactValue: prUrl,
      reason: `Created pull request ${prUrl}`
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
      return { handled: true, reason: "Ignored staged issue promotion because the issue number was missing or invalid" };
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
      return {
        handled: true,
        reason: `Ignored promotion because issue #${issueNumber} is not a valid staged issue`,
        artifactType: "issue",
        artifactValue: String(issueNumber)
      };
    }

    if (stagedMetadata.repoFullName !== feedbackItem.repoFullName) {
      return {
        handled: true,
        reason: `Ignored promotion because staged issue #${issueNumber} metadata does not match ${feedbackItem.repoFullName}`,
        artifactType: "issue",
        artifactValue: String(issueNumber)
      };
    }

    if (labels.includes(STAGED_ISSUE_PROMOTED_LABEL)) {
      await this.postIssueComment(
        feedbackItem.repoFullName,
        repoContext.installationId,
        issueNumber,
        "Mosaic already opened a PR for this issue."
      );
      return {
        handled: true,
        reason: `Issue #${issueNumber} was already promoted`,
        artifactType: "issue",
        artifactValue: String(issueNumber)
      };
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
      return {
        handled: true,
        reason: `Ignored unauthorized promotion request for issue #${issueNumber}`,
        artifactType: "issue",
        artifactValue: String(issueNumber)
      };
    }

    const stagedFeedback: ClassifiedFeedback = {
      id: feedbackItem.id,
      source: stagedMetadata.source,
      rawContent: `${stagedMetadata.rawContent}\n\nLinked GitHub issue #${issueNumber}:\n${stripMosaicMetadataComments(issue.body ?? "")}`,
      senderIdentifier: stagedMetadata.senderIdentifier,
      repoFullName: feedbackItem.repoFullName,
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
      reason: result.reason,
      artifactType: result.artifactType,
      artifactValue: result.artifactValue
    };
  }

  async process(feedbackItem: FeedbackItem): Promise<FeedbackJobResult> {
    feedbackItem = this.normalizeFeedbackItem(feedbackItem);

    const existingArtifact = await this.artifactStore.get(feedbackItem.id);
    if (existingArtifact) {
      logger.warn(
        { feedbackId: feedbackItem.id, artifactType: existingArtifact.artifactType, artifactValue: existingArtifact.artifactValue },
        "Feedback already produced an artifact, skipping duplicate processing"
      );
      return {
        outcome: "succeeded",
        reason: `Skipped duplicate feedback; existing ${existingArtifact.artifactType} artifact is ${existingArtifact.artifactValue}`
      };
    }

    const repoContext = await this.repoIndexer.getContext(feedbackItem.repoFullName);
    const repoConfig = await this.runtimeConfigLoader(repoContext.localPath, feedbackItem.repoFullName);
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
      return {
        outcome: "succeeded",
        reason: stagedIssuePromotion.reason ?? "Handled staged issue promotion request"
      };
    }

    const topLevelFileTree = repoContext.fileTree.map((node) => node.path);
    let classifiedFeedback: ClassifiedFeedback;
    if (repoConfig.llmProvider === "openai") {
      const initialClient = this.createLlmClient(
        "openai",
        repoConfig.llmKeyMode,
        repoConfig.llmApiKey,
        OPENAI_MODEL_IDS.mini,
        "none"
      );
      classifiedFeedback = await new FeedbackClassifier(initialClient).classify(feedbackItem, topLevelFileTree);
      if (classifiedFeedback.complexity !== "trivial") {
        const reviewMode = classifiedFeedback.complexity === "moderate"
          ? getModerateIssueMode(classifiedFeedback)
          : classifiedFeedback.complexity === "complex"
            ? "complex-review-needed"
            : undefined;
        const selection = selectOpenAIModel(classifiedFeedback, repoConfig.llmModelPreset, reviewMode);
        const routedClient = this.createLlmClient(
          "openai",
          repoConfig.llmKeyMode,
          repoConfig.llmApiKey,
          selection.model,
          selection.reasoningEffort
        );
        classifiedFeedback = await new FeedbackClassifier(routedClient).classify(feedbackItem, topLevelFileTree);
      }
    } else {
      const haikuClient = this.createLlmClient("anthropic", repoConfig.llmKeyMode, repoConfig.llmApiKey, ANTHROPIC_MODEL_IDS.haiku);
      const sonnetClient = this.createLlmClient("anthropic", repoConfig.llmKeyMode, repoConfig.llmApiKey, ANTHROPIC_MODEL_IDS.sonnet);
      classifiedFeedback = await new FeedbackClassifier(haikuClient).classify(feedbackItem, topLevelFileTree);
      if (shouldEscalateClassification(classifiedFeedback)) {
        classifiedFeedback = await new FeedbackClassifier(sonnetClient).classify(feedbackItem, topLevelFileTree);
      }
    }
    const decision = this.dispositionDecider(classifiedFeedback, repoConfig);

    if (decision.disposition === "quarantine") {
      await this.quarantineStore.quarantine(classifiedFeedback, decision.reason);
      await this.artifactStore.record({
        feedbackId: classifiedFeedback.id,
        repoFullName: classifiedFeedback.repoFullName,
        artifactType: "quarantine",
        artifactValue: decision.reason,
        createdAt: new Date().toISOString()
      });
      return {
        outcome: "succeeded",
        reason: `Quarantined feedback because ${decision.reason}`
      };
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
      return {
        outcome: "succeeded",
        reason: `Created issue #${issueNumber} because ${decision.reason}`
      };
    }

    const result = await this.automatePullRequest(classifiedFeedback, repoContext, repoConfig);
    await this.artifactStore.record({
      feedbackId: classifiedFeedback.id,
      repoFullName: classifiedFeedback.repoFullName,
      artifactType: result.artifactType,
      artifactValue: result.artifactValue,
      createdAt: new Date().toISOString()
    });
    return {
      outcome: "succeeded",
      reason: result.reason
    };
  }

  createWorker(): Worker<FeedbackItem, FeedbackJobResult> {
    return new Worker<FeedbackItem, FeedbackJobResult>(
      FEEDBACK_QUEUE_NAME,
      async (job) => {
        try {
          return await this.process(job.data);
        } catch (error) {
          if (error instanceof RateLimitError) {
            await this.getRetryQueue().add("feedback-item", job.data, {
              delay: 60_000,
              attempts: 3,
              backoff: {
                type: "exponential",
                delay: 1_000
              }
            });
            logger.warn({ repo: job.data.repoFullName }, "Rate limit hit, re-queued feedback job");
            return {
              outcome: "requeued",
              reason: "Rate limit hit; feedback job was queued for another attempt"
            };
          }

          if (isRetryableLlmOverload(error) && canRetryLlmOverload(job.data)) {
            const retriedJob = buildLlmRetryFeedbackItem(job.data);
            const delay = getLlmRetryDelayMs(job.data);

            await this.getRetryQueue().add("feedback-item", retriedJob, {
              delay,
              attempts: 1
            });
            logger.warn(
              { repo: job.data.repoFullName, feedbackId: job.data.id, retryCount: retriedJob.metadata.__llmRetryCount, delay },
              "Transient LLM overload, re-queued feedback job"
            );
            return {
              outcome: "requeued",
              reason: `Transient LLM overload; feedback job was queued to retry in ${delay}ms`
            };
          }

          throw error;
        }
      },
      {
        connection: this.getConnection(),
        concurrency: getEnv().WORKER_CONCURRENCY,
        lockDuration: getEnv().WORKER_LOCK_DURATION_MS,
        stalledInterval: getEnv().WORKER_STALLED_INTERVAL_MS,
        maxStalledCount: getEnv().WORKER_MAX_STALLED_COUNT
      }
    );
  }
}
