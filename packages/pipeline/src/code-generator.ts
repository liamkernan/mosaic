import { LLMError, type ClassifiedFeedback, type GeneratedChange, type RelevantFile } from "@mosaic/core";
import type { LLMClient } from "@mosaic/llm";

import { parseGeneratedChanges } from "./generated-change-parser.js";
import { buildGenerationPrompt } from "./prompts/generate.prompt.js";
import { buildGenerationRepairPrompt, buildValidationRepairPrompt } from "./prompts/repair-generate.prompt.js";
import type { ImplementationPlan } from "./implementation-planner.js";

const GENERATION_TIMEOUT_MS = 180_000;
const LARGE_STATIC_FRONTEND_BYTES = 25_000;
const STATIC_FRONTEND_RETRY_BYTES = 15_000;
const COMPACT_STATIC_ASSET_BYTES = 8_000;
const RETRY_COMPACT_STATIC_ASSET_BYTES = 4_000;
const STATIC_FRONTEND_RETRY_MAX_TOKENS = 12_288;
const VALIDATION_REPAIR_TIMEOUT_MS = 120_000;
const VALIDATION_REPAIR_MAX_TOKENS = 12_288;

interface GenerationOptions {
  completeSolution?: boolean;
}

interface PromptFileOptions {
  compactAssetBytes: number;
}

function estimateGenerationMaxTokens(relevantFiles: RelevantFile[], options: GenerationOptions = {}): number {
  const totalBytes = relevantFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const estimatedTokens = Math.ceil(totalBytes / 3) + (options.completeSolution ? 8_192 : 2_048);
  const floor = options.completeSolution ? 8_192 : 4_096;
  const ceiling = options.completeSolution ? 32_768 : 16_384;
  return Math.max(floor, Math.min(ceiling, estimatedTokens));
}

function isStaticFrontendFile(filePath: string): boolean {
  return /\.(?:html?|css|[cm]?js)$/i.test(filePath);
}

function totalStaticFrontendBytes(relevantFiles: RelevantFile[]): number {
  return relevantFiles
    .filter((file) => isStaticFrontendFile(file.path))
    .reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
}

function shouldCompactStaticFrontendContext(relevantFiles: RelevantFile[]): boolean {
  return totalStaticFrontendBytes(relevantFiles) > LARGE_STATIC_FRONTEND_BYTES;
}

function shouldRetryStaticFrontendGeneration(relevantFiles: RelevantFile[], error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorMessage = error.message.toLowerCase();
  if (!errorMessage.includes("timed out") && !errorMessage.includes("timeout")) {
    return false;
  }

  return totalStaticFrontendBytes(relevantFiles) > STATIC_FRONTEND_RETRY_BYTES;
}

function compactFileContent(file: RelevantFile, options: PromptFileOptions): RelevantFile {
  if (!/\.(?:css|[cm]?js)$/i.test(file.path) || Buffer.byteLength(file.content) <= options.compactAssetBytes) {
    return file;
  }

  const lines = file.content.split("\n");
  const head = lines.slice(0, 120).join("\n");
  const tail = lines.slice(-120).join("\n");

  return {
    ...file,
    content: `${head}\n\n/* MOSAIC CONTEXT NOTE: middle of ${file.path} omitted for generation speed. Prefer adding new scoped supplemental files instead of rewriting this large existing asset unless necessary. */\n\n${tail}`,
    reason: `${file.reason}; compacted large static asset context`
  };
}

function promptRelevantFiles(relevantFiles: RelevantFile[], options: PromptFileOptions = { compactAssetBytes: COMPACT_STATIC_ASSET_BYTES }): RelevantFile[] {
  if (!shouldCompactStaticFrontendContext(relevantFiles)) {
    return relevantFiles;
  }

  return relevantFiles.map((file) => compactFileContent(file, options));
}

function retryPromptRelevantFiles(relevantFiles: RelevantFile[]): RelevantFile[] {
  const totalStaticBytes = relevantFiles
    .filter((file) => isStaticFrontendFile(file.path))
    .reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);

  if (totalStaticBytes <= STATIC_FRONTEND_RETRY_BYTES) {
    return relevantFiles;
  }

  return relevantFiles.map((file) => compactFileContent(file, { compactAssetBytes: RETRY_COMPACT_STATIC_ASSET_BYTES }));
}

function hasOversizedPatchValidationError(validationErrors: string[]): boolean {
  return validationErrors.some((error) =>
    /too large|exceeds limit|total new code added/i.test(error)
  );
}

function hasMissingInteractiveBehaviorValidationError(validationErrors: string[]): boolean {
  return validationErrors.some((error) =>
    (/modal|overlay|dialog/i.test(error) && /behavior|script/i.test(error)) ||
    /queries missing HTML id|queries selector/i.test(error)
  );
}

function hasMissingHtmlHookValidationError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /queries missing HTML id|queries selector/i.test(error));
}

function hasFrontendVerificationFailure(validationErrors: string[]): boolean {
  return validationErrors.some((error) =>
    /Verification failed:/i.test(error) &&
    /expected element|expected at least|expected .*matches|click target|frontend runtime|selector|hasClass|attribute/i.test(error)
  );
}

export class CodeGenerator {
  constructor(private readonly llmClient: LLMClient) {}

  private toGeneratedChanges(
    parsed: Array<{ filePath: string; modifiedContent?: string; search?: string; replace?: string; explanation: string }>,
    relevantFiles: RelevantFile[]
  ): GeneratedChange[] {
    const originals = new Map(relevantFiles.map((file) => [file.path, file.content]));

    return parsed
      .map((change) => {
        const originalContent = originals.get(change.filePath) ?? "";
        if (change.modifiedContent !== undefined) {
          return {
            filePath: change.filePath,
            originalContent,
            modifiedContent: change.modifiedContent,
            explanation: change.explanation
          };
        }

        if (change.search === undefined || change.replace === undefined) {
          throw new LLMError(`Change for ${change.filePath} did not include modifiedContent or search/replace edit`);
        }

        if (originalContent.length === 0) {
          throw new LLMError(`Search/replace edit cannot create new file ${change.filePath}`);
        }

        const firstIndex = originalContent.indexOf(change.search);
        if (firstIndex === -1) {
          throw new LLMError(`Search block for ${change.filePath} was not found exactly once`);
        }

        if (originalContent.indexOf(change.search, firstIndex + change.search.length) !== -1) {
          throw new LLMError(`Search block for ${change.filePath} matched more than once`);
        }

        return {
          filePath: change.filePath,
          originalContent,
          modifiedContent: originalContent.slice(0, firstIndex) + change.replace + originalContent.slice(firstIndex + change.search.length),
          explanation: change.explanation
        };
      })
      .filter((change) => change.originalContent !== change.modifiedContent);
  }

  async generate(
    feedback: ClassifiedFeedback,
    relevantFiles: RelevantFile[],
    fileTree: string[],
    implementationPlan?: ImplementationPlan,
    options: GenerationOptions = {}
  ): Promise<GeneratedChange[]> {
    this.llmClient.setUsageContext({
      repoFullName: feedback.repoFullName,
      feedbackId: feedback.id
    });

    const promptFiles = promptRelevantFiles(relevantFiles);
    const maxTokens = estimateGenerationMaxTokens(promptFiles, options);

    let response;
    try {
      response = await this.llmClient.complete(
        buildGenerationPrompt(feedback.summary, promptFiles, fileTree, implementationPlan, options),
        "Return only the <changes> payload with complete file contents in CDATA blocks.",
        {
          temperature: 0.3,
          maxTokens,
          timeoutMs: GENERATION_TIMEOUT_MS
        }
      );
    } catch (error) {
      if (!shouldRetryStaticFrontendGeneration(relevantFiles, error)) {
        throw error;
      }

      const retryFiles = retryPromptRelevantFiles(relevantFiles);
      response = await this.llmClient.complete(
        buildGenerationPrompt(feedback.summary, retryFiles, fileTree, implementationPlan, options),
        "The previous static frontend generation timed out. Return only the smallest complete <changes> payload. Prefer one reusable data-driven modal, and include matching behavior and styles in existing linked JS/CSS when the UI needs them.",
        {
          temperature: 0.2,
          maxTokens: Math.min(estimateGenerationMaxTokens(retryFiles, options), STATIC_FRONTEND_RETRY_MAX_TOKENS),
          timeoutMs: GENERATION_TIMEOUT_MS
        }
      );
    }

    let parsed;
    try {
      parsed = parseGeneratedChanges(response);
    } catch (error) {
      if (!(error instanceof LLMError)) {
        throw error;
      }

      const repairedResponse = await this.llmClient.complete(
        buildGenerationRepairPrompt(response),
        "Return only the repaired <changes> payload with complete file contents in CDATA blocks.",
        {
          temperature: 0,
          maxTokens,
          timeoutMs: GENERATION_TIMEOUT_MS
        }
      );

      parsed = parseGeneratedChanges(repairedResponse);
    }

    return this.toGeneratedChanges(parsed, relevantFiles);
  }

  async repairValidationFailure(
    feedback: ClassifiedFeedback,
    relevantFiles: RelevantFile[],
    fileTree: string[],
    currentChanges: GeneratedChange[],
    validationErrors: string[],
    implementationPlan?: ImplementationPlan,
    options: GenerationOptions = {}
  ): Promise<GeneratedChange[]> {
    this.llmClient.setUsageContext({
      repoFullName: feedback.repoFullName,
      feedbackId: feedback.id
    });

    const promptFiles = promptRelevantFiles(relevantFiles);
    const oversizedRepair = hasOversizedPatchValidationError(validationErrors);
    const missingHtmlHookRepair = hasMissingHtmlHookValidationError(validationErrors);
    const missingBehaviorRepair = hasMissingInteractiveBehaviorValidationError(validationErrors);
    const frontendVerificationRepair = hasFrontendVerificationFailure(validationErrors);
    const focusedRepair = oversizedRepair || missingBehaviorRepair || frontendVerificationRepair;
    const maxTokens = focusedRepair
      ? Math.min(estimateGenerationMaxTokens(promptFiles, { completeSolution: false }), VALIDATION_REPAIR_MAX_TOKENS)
      : estimateGenerationMaxTokens(promptFiles, options);
    const userMessage = oversizedRepair
      ? "Return only a compact repaired <changes> payload. The previous patch exceeded validation limits, so remove repeated markup/data and use one reusable data-driven implementation with matching JS/CSS."
      : missingHtmlHookRepair
        ? "Return only a repaired <changes> payload focused on mismatched HTML and JavaScript hooks. Add the exact missing ids/classes/data attributes to the HTML, or retarget the script to hooks that already exist. Include both HTML and JS edits when needed; do not leave selectors that match nothing."
      : missingBehaviorRepair
        ? "Return only a repaired <changes> payload focused on missing interactive behavior. Add or update JavaScript that opens, populates, closes, and keyboard-wires the modal/dialog/overlay using the exact new markup ids/classes/data attributes; do not return HTML/CSS-only repairs."
      : frontendVerificationRepair
        ? "Return only a repaired <changes> payload focused on the failing frontend verification assertions. Treat the reported selectors, ids, classes, text, attributes, counts, and runtime errors as binding executable contracts; update the smallest matching HTML, CSS, and JS hooks needed."
      : "Return only the repaired <changes> payload with complete file contents in CDATA blocks.";
    const response = await this.llmClient.complete(
      buildValidationRepairPrompt(feedback.summary, promptFiles, currentChanges, validationErrors, fileTree, implementationPlan),
      userMessage,
      {
        temperature: 0,
        maxTokens,
        timeoutMs: focusedRepair ? VALIDATION_REPAIR_TIMEOUT_MS : GENERATION_TIMEOUT_MS
      }
    );

    return this.toGeneratedChanges(parseGeneratedChanges(response), relevantFiles);
  }
}
