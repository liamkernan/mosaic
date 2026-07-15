import {
  type ClassifiedFeedback,
  type ClassificationRoutingSignals,
  type FeedbackCategory,
  type FeedbackItem,
  type ComplexityLevel
} from "@mosaic/core";
import { buildClassificationPrompt } from "./prompts/classify.prompt.js";
import {
  applyRoutingSignalComplexityFloor,
  isClassificationRoutingSignals
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
  routingSignals?: unknown;
}

export interface FeedbackClassifierOptions {
  modelVisiblePlanPathPolicy?: ModelVisiblePlanPathPolicy;
}

export class FeedbackClassifier {
  constructor(
    private readonly llmClient: ClassificationClient,
    private readonly options: FeedbackClassifierOptions = {}
  ) {}

  async classify(item: FeedbackItem, fileTree: string[]): Promise<ClassifiedFeedback> {
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
    const systemPrompt = buildClassificationPrompt(modelVisibleItem.rawContent, modelVisibleFileTree);

    let parsed: ClassifierResponse | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.llmClient.complete(systemPrompt, "Return only the JSON classification.", {
        temperature: 0.2,
        maxTokens: 1_024,
        requestPhase: "classification"
      });

      try {
        parsed = JSON.parse(response) as ClassifierResponse;
        break;
      } catch {
        parsed = undefined;
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

    const routingSignals: ClassificationRoutingSignals | undefined = isClassificationRoutingSignals(parsed.routingSignals)
      ? parsed.routingSignals
      : undefined;
    const summary = policy
      ? sanitizeModelVisibleContext(parsed.summary, policy)
      : parsed.summary;
    const relevantFiles = policy
      ? sanitizeModelVisiblePaths(parsed.relevantFiles, policy)
      : parsed.relevantFiles;

    return {
      ...modelVisibleItem,
      category: parsed.category,
      complexity: applyRoutingSignalComplexityFloor(parsed.complexity, routingSignals),
      summary,
      relevantFiles: relevantFiles.slice(0, 5),
      confidence: parsed.confidence,
      ...(routingSignals ? { routingSignals } : {})
    };
  }
}
