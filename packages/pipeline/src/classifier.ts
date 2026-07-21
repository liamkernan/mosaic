import {
  type ClassifiedFeedback,
  type ClassificationRoutingSignals,
  type ComplexityLevel,
  type FeedbackCategory,
  type FeedbackItem,
  type RelevantFile
} from "@mosaic/core";
import { buildClassificationPrompt } from "./prompts/classify.prompt.js";
import {
  isCompleteClassificationRoutingSignals,
  resolveRoutingSignalComplexity
} from "./routing-signals.js";
import {
  sanitizeModelVisibleContext,
  sanitizeModelVisiblePaths,
  type ModelVisiblePlanPathPolicy
} from "./implementation-plan-sanitizer.js";

interface ClassificationClient {
  setUsageContext(context: { repoFullName: string; feedbackId: string }): void;
  complete(
    systemPrompt: string,
    userMessage: string,
    options: { temperature: number; maxTokens: number; requestPhase?: string }
  ): Promise<string>;
}

interface ClassifierResponse {
  category: FeedbackCategory;
  complexity: ComplexityLevel;
  summary: string;
  relevantFiles: string[];
  confidence: number;
  routingSignals: ClassificationRoutingSignals;
}

export interface FeedbackClassifierOptions {
  modelVisiblePlanPathPolicy?: ModelVisiblePlanPathPolicy;
}

const feedbackCategories = new Set<FeedbackCategory>([
  "bug_report",
  "feature_request",
  "copy_change",
  "ui_tweak",
  "question",
  "other"
]);
const complexityLevels = new Set<ComplexityLevel>(["trivial", "simple", "moderate", "complex"]);
const complexityRanking: ComplexityLevel[] = ["trivial", "simple", "moderate", "complex"];

function parseClassifierResponse(response: string): ClassifierResponse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const parsed = value as Record<string, unknown>;
  if (
    !feedbackCategories.has(parsed.category as FeedbackCategory) ||
    !complexityLevels.has(parsed.complexity as ComplexityLevel) ||
    typeof parsed.summary !== "string" ||
    parsed.summary.trim().length === 0 ||
    !Array.isArray(parsed.relevantFiles) ||
    !parsed.relevantFiles.every((filePath) => typeof filePath === "string") ||
    typeof parsed.confidence !== "number" ||
    !Number.isFinite(parsed.confidence) ||
    parsed.confidence < 0 ||
    parsed.confidence > 1 ||
    !isCompleteClassificationRoutingSignals(parsed.routingSignals)
  ) {
    return undefined;
  }

  const declaredComplexity = parsed.complexity as ComplexityLevel;
  const routingSignals = parsed.routingSignals;
  const signalComplexity = resolveRoutingSignalComplexity(declaredComplexity, routingSignals);
  const tierDistance = Math.abs(
    complexityRanking.indexOf(declaredComplexity) - complexityRanking.indexOf(signalComplexity)
  );
  if (tierDistance > 1) {
    return undefined;
  }

  return {
    category: parsed.category as FeedbackCategory,
    complexity: declaredComplexity,
    summary: parsed.summary.trim(),
    relevantFiles: [...new Set(parsed.relevantFiles.map((filePath) => filePath.trim()).filter(Boolean))],
    confidence: parsed.confidence,
    routingSignals
  };
}

function sanitizeGroundingFiles(
  files: RelevantFile[],
  policy: ModelVisiblePlanPathPolicy | undefined
): RelevantFile[] {
  if (!policy) {
    return files;
  }

  const visiblePaths = new Set(sanitizeModelVisiblePaths(files.map((file) => file.path), policy));
  return files
    .filter((file) => visiblePaths.has(file.path))
    .map((file) => ({
      ...file,
      content: sanitizeModelVisibleContext(file.content, policy),
      reason: sanitizeModelVisibleContext(file.reason, policy)
    }));
}

export class FeedbackClassifier {
  constructor(
    private readonly llmClient: ClassificationClient,
    private readonly options: FeedbackClassifierOptions = {}
  ) {}

  async classify(
    item: FeedbackItem,
    fileTree: string[],
    groundingFiles: RelevantFile[] = []
  ): Promise<ClassifiedFeedback> {
    this.llmClient.setUsageContext({
      repoFullName: item.repoFullName,
      feedbackId: item.id
    });

    const policy = this.options.modelVisiblePlanPathPolicy;
    const modelVisibleItem = policy
      ? { ...item, rawContent: sanitizeModelVisibleContext(item.rawContent, policy) }
      : item;
    const modelVisibleFileTree = policy
      ? sanitizeModelVisiblePaths(fileTree, policy)
      : fileTree;
    const modelVisibleGroundingFiles = sanitizeGroundingFiles(groundingFiles, policy);
    const systemPrompt = buildClassificationPrompt(
      modelVisibleItem.rawContent,
      modelVisibleFileTree,
      modelVisibleGroundingFiles
    );

    let parsed: ClassifierResponse | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const userMessage = attempt === 0
        ? "Return only the JSON classification."
        : "The previous response was malformed or internally inconsistent. Return one complete JSON object matching the schema and routing rules exactly.";
      const response = await this.llmClient.complete(systemPrompt, userMessage, {
        temperature: 0,
        maxTokens: 1_024,
        requestPhase: "classification"
      });

      parsed = parseClassifierResponse(response);
      if (parsed) {
        break;
      }
    }

    if (!parsed) {
      return {
        ...modelVisibleItem,
        category: "other",
        complexity: "complex",
        summary: "Unable to classify feedback safely",
        relevantFiles: [],
        confidence: 0
      };
    }

    const routingSignals = parsed.routingSignals;
    const summary = policy
      ? sanitizeModelVisibleContext(parsed.summary, policy)
      : parsed.summary;
    const relevantFiles = policy
      ? sanitizeModelVisiblePaths(parsed.relevantFiles, policy)
      : parsed.relevantFiles;
    const repositoryPaths = new Set(modelVisibleFileTree);
    const existingRelevantFiles = relevantFiles.filter((filePath) => repositoryPaths.has(filePath));

    return {
      ...modelVisibleItem,
      category: parsed.category,
      complexity: resolveRoutingSignalComplexity(parsed.complexity, routingSignals),
      summary,
      relevantFiles: existingRelevantFiles.slice(0, 5),
      confidence: parsed.confidence,
      routingSignals
    };
  }
}
