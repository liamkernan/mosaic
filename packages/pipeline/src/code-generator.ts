import { LLMError, type ClassifiedFeedback, type GeneratedChange, type RelevantFile } from "@mosaic/core";
import type { LLMClient } from "@mosaic/llm";

import { parseGeneratedChanges } from "./generated-change-parser.js";
import { buildGenerationPrompt } from "./prompts/generate.prompt.js";
import { buildGenerationRepairPrompt, buildValidationRepairPrompt } from "./prompts/repair-generate.prompt.js";
import type { ImplementationPlan } from "./implementation-planner.js";

const GENERATION_TIMEOUT_MS = 180_000;
const STATIC_FRONTEND_GENERATION_TIMEOUT_MS = 45_000;
const STATIC_FRONTEND_RETRY_TIMEOUT_MS = 120_000;
const LARGE_STATIC_FRONTEND_BYTES = 25_000;
const STATIC_FRONTEND_RETRY_BYTES = 15_000;
const COMPACT_STATIC_ASSET_BYTES = 8_000;
const RETRY_COMPACT_STATIC_ASSET_BYTES = 4_000;
const STATIC_FRONTEND_RETRY_MAX_TOKENS = 8_192;
const VALIDATION_REPAIR_TIMEOUT_MS = 120_000;
const VALIDATION_REPAIR_MAX_TOKENS = 12_288;

interface GenerationOptions {
  completeSolution?: boolean;
}

interface PromptFileOptions {
  compactAssetBytes: number;
  compactHtml?: boolean;
  keywords?: string[];
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

function extractKeywords(text: string): string[] {
  const stopwords = new Set(["about", "add", "and", "for", "from", "into", "make", "open", "that", "the", "them", "this", "with"]);
  return [...new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])]
    .filter((word) => !stopwords.has(word))
    .slice(0, 12);
}

function compactHtmlContent(file: RelevantFile, options: PromptFileOptions): RelevantFile {
  if (!options.compactHtml || !/\.html?$/i.test(file.path) || Buffer.byteLength(file.content) <= options.compactAssetBytes) {
    return file;
  }

  const lines = file.content.split("\n");
  const headLines = options.compactAssetBytes <= RETRY_COMPACT_STATIC_ASSET_BYTES ? 40 : 80;
  const tailLines = options.compactAssetBytes <= RETRY_COMPACT_STATIC_ASSET_BYTES ? 30 : 60;
  const keywords = options.keywords ?? [];
  const matchedIndexes = lines
    .map((line, index) => ({ line: line.toLowerCase(), index }))
    .filter(({ line }) => keywords.some((keyword) => line.includes(keyword)))
    .map(({ index }) => index)
    .slice(0, 8);
  const includedIndexes = new Set<number>();

  for (let index = 0; index < Math.min(headLines, lines.length); index += 1) {
    includedIndexes.add(index);
  }

  for (const matchIndex of matchedIndexes) {
    for (let index = Math.max(0, matchIndex - 5); index <= Math.min(lines.length - 1, matchIndex + 10); index += 1) {
      includedIndexes.add(index);
    }
  }

  for (let index = Math.max(0, lines.length - tailLines); index < lines.length; index += 1) {
    includedIndexes.add(index);
  }

  const excerpt = [...includedIndexes]
    .sort((a, b) => a - b)
    .map((index, position, indexes) => {
      const previous = indexes[position - 1];
      const prefix = previous !== undefined && index > previous + 1
        ? `\n<!-- MOSAIC CONTEXT NOTE: ${index - previous - 1} middle line(s) of ${file.path} omitted. -->\n`
        : "";
      return `${prefix}${lines[index]}`;
    })
    .join("\n");

  return {
    ...file,
    content: `${excerpt}\n\n<!-- MOSAIC CONTEXT NOTE: ${file.path} was compacted for static frontend retry. Prefer localized <edit> blocks or small supplemental assets. -->`,
    reason: `${file.reason}; compacted large static HTML context`
  };
}

function compactFileContent(file: RelevantFile, options: PromptFileOptions): RelevantFile {
  const htmlCompacted = compactHtmlContent(file, options);
  if (htmlCompacted !== file) {
    return htmlCompacted;
  }

  if (!/\.(?:css|[cm]?js)$/i.test(file.path) || Buffer.byteLength(file.content) <= options.compactAssetBytes) {
    return file;
  }

  const lines = file.content.split("\n");
  const contextLines = options.compactAssetBytes <= RETRY_COMPACT_STATIC_ASSET_BYTES ? 40 : 120;
  const head = lines.slice(0, contextLines).join("\n");
  const tail = lines.slice(-contextLines).join("\n");

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

function retryPromptRelevantFiles(relevantFiles: RelevantFile[], keywords: string[]): RelevantFile[] {
  const totalStaticBytes = relevantFiles
    .filter((file) => isStaticFrontendFile(file.path))
    .reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);

  if (totalStaticBytes <= STATIC_FRONTEND_RETRY_BYTES) {
    return relevantFiles;
  }

  return relevantFiles.map((file) => compactFileContent(file, {
    compactAssetBytes: RETRY_COMPACT_STATIC_ASSET_BYTES,
    compactHtml: true,
    keywords
  }));
}

function hasOversizedPatchValidationError(validationErrors: string[]): boolean {
  return validationErrors.some((error) =>
    /too large|exceeds limit|total new code added/i.test(error)
  );
}

function hasMissingInteractiveBehaviorValidationError(validationErrors: string[]): boolean {
  return validationErrors.some((error) =>
    (/modal|overlay|dialog/i.test(error) && /behavior|script/i.test(error)) ||
    /queries missing HTML id|queries selector|keyboard activation behavior|accessible non-native control/i.test(error)
  );
}

function hasMissingHtmlHookValidationError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /queries missing HTML id|queries selector/i.test(error));
}

function hasMissingBehavioralTestCoverageError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /requires behavioral test coverage|does not modify any test\/spec file/i.test(error));
}

function hasMissingIdempotencyUpdateError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /idempotent duplicate\/retry update path|idempotency key|look up and update an existing record/i.test(error));
}

function hasTestApiShapeMismatchError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /generated test asserts field|wrong public API shape|does not expose that field/i.test(error));
}

function hasMissingPythonImportError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /calls .* from .*\.py but does not import or define/i.test(error));
}

function hasMissingEndpointRouteError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /require endpoint path .* no implementation change appears to route or handle/i.test(error));
}

function hasMissingRuntimeChangeError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /requires runtime\/source changes|only modifies tests or documentation/i.test(error));
}

function hasFrontendVerificationFailure(validationErrors: string[]): boolean {
  return validationErrors.some((error) =>
    /Verification failed:/i.test(error) &&
    /expected element|expected at least|expected .*matches|click target|frontend runtime|selector|hasClass|attribute/i.test(error)
  );
}

function hasTestVerificationFailure(validationErrors: string[]): boolean {
  return validationErrors.some((error) =>
    /Verification failed:/i.test(error) &&
    /(?:FAILED|ERROR|AssertionError|KeyError|AttributeError|Traceback|pytest|unittest|jest|vitest|test_|\.(?:test|spec)\.)/i.test(error)
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
    const generationTimeoutMs = shouldCompactStaticFrontendContext(relevantFiles)
      ? STATIC_FRONTEND_GENERATION_TIMEOUT_MS
      : GENERATION_TIMEOUT_MS;

    let response;
    try {
      response = await this.llmClient.complete(
        buildGenerationPrompt(feedback.summary, promptFiles, fileTree, implementationPlan, options),
        "Return only the <changes> payload with complete file contents in CDATA blocks.",
        {
          temperature: 0.3,
          maxTokens,
          timeoutMs: generationTimeoutMs
        }
      );
    } catch (error) {
      if (!shouldRetryStaticFrontendGeneration(relevantFiles, error)) {
        throw error;
      }

      const retryFiles = retryPromptRelevantFiles(relevantFiles, extractKeywords(`${feedback.summary} ${feedback.rawContent}`));
      response = await this.llmClient.complete(
        buildGenerationPrompt(feedback.summary, retryFiles, fileTree, implementationPlan, options),
        "The previous static frontend generation timed out. Return only a small localized <changes> payload: prefer exact <edit> blocks or new scoped supplemental JS/CSS files linked from HTML. Do not rewrite full existing HTML/CSS/JS files. Implement one reusable data-driven modal/dialog and matching behavior/styles.",
        {
          temperature: 0.2,
          maxTokens: Math.min(estimateGenerationMaxTokens(retryFiles, options), STATIC_FRONTEND_RETRY_MAX_TOKENS),
          timeoutMs: STATIC_FRONTEND_RETRY_TIMEOUT_MS
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
    const missingTestCoverageRepair = hasMissingBehavioralTestCoverageError(validationErrors);
    const missingIdempotencyUpdateRepair = hasMissingIdempotencyUpdateError(validationErrors);
    const testApiShapeMismatchRepair = hasTestApiShapeMismatchError(validationErrors);
    const missingPythonImportRepair = hasMissingPythonImportError(validationErrors);
    const missingEndpointRouteRepair = hasMissingEndpointRouteError(validationErrors);
    const missingRuntimeChangeRepair = hasMissingRuntimeChangeError(validationErrors);
    const missingBehaviorRepair = hasMissingInteractiveBehaviorValidationError(validationErrors);
    const frontendVerificationRepair = hasFrontendVerificationFailure(validationErrors);
    const testVerificationRepair = hasTestVerificationFailure(validationErrors);
    const focusedRepair = oversizedRepair || missingBehaviorRepair || missingTestCoverageRepair || missingIdempotencyUpdateRepair || testApiShapeMismatchRepair || missingPythonImportRepair || missingEndpointRouteRepair || missingRuntimeChangeRepair || frontendVerificationRepair || testVerificationRepair;
    const maxTokens = focusedRepair
      ? Math.min(estimateGenerationMaxTokens(promptFiles, { completeSolution: false }), VALIDATION_REPAIR_MAX_TOKENS)
      : estimateGenerationMaxTokens(promptFiles, options);
    const userMessage = oversizedRepair
      ? "Return only a compact repaired <changes> payload. The previous patch exceeded validation limits, so remove repeated markup/data and use one reusable data-driven implementation with matching JS/CSS."
      : missingHtmlHookRepair
        ? "Return only a repaired <changes> payload focused on mismatched HTML and JavaScript hooks. Add the exact missing ids/classes/data attributes to the HTML, or retarget the script to hooks that already exist. Include both HTML and JS edits when needed; do not leave selectors that match nothing."
      : missingTestCoverageRepair
        ? "Return only a repaired <changes> payload focused on missing behavioral test coverage. Keep the implementation changes and add or update a focused test/spec file already present in the repository or required by the implementation plan; do not return an implementation-only repair."
      : missingIdempotencyUpdateRepair
        ? "Return only a repaired <changes> payload focused on the missing idempotent duplicate/retry update path. Include an implementation edit, not tests only. In the create/insert path, normalize the stated source/key inputs, look up an existing open record by the idempotency key before INSERT/create, UPDATE that existing record and return it with the same id when found, add any expected audit/update side effects, and preserve normal distinct creation when the key is absent or different. Use a full-file <change> when a localized search/replace is risky."
      : testApiShapeMismatchRepair
        ? "Return only a repaired <changes> payload focused on the test/API shape mismatch. If a generated test reads a field from a list/query/API result that the implementation does not expose, either update the implementation to expose that field when it is part of the requested public behavior, or repair the test to assert through an existing returned object or supported accessor. Preserve behavioral coverage; do not delete assertions just to pass validation."
      : missingPythonImportRepair
        ? "Return only a repaired <changes> payload focused on the missing Python import. Preserve the implementation and tests; update the caller module import or qualified reference so every newly called sibling-module helper is actually imported or defined."
      : missingEndpointRouteRepair
        ? "Return only a repaired <changes> payload focused on the missing endpoint route. Preserve the service/helper implementation and tests; update the routing or handler surface so the exact requested HTTP path is handled and returns the requested response instead of falling through to not found."
      : missingRuntimeChangeRepair
        ? "Return only a repaired <changes> payload focused on the missing runtime/source implementation. Preserve useful tests and documentation, but add or update the actual application source files named by the implementation plan so the user's reported behavior changes in the running software; do not return tests/docs-only repairs."
      : missingBehaviorRepair
        ? "Return only a repaired <changes> payload focused on missing interactive behavior. Add or update JavaScript that opens, populates, closes, and keyboard-wires the modal/dialog/overlay using the exact new markup ids/classes/data attributes; do not return HTML/CSS-only repairs."
      : frontendVerificationRepair
        ? "Return only a repaired <changes> payload focused on the failing frontend verification assertions. Treat the reported selectors, ids, classes, text, attributes, counts, and runtime errors as binding executable contracts; update the smallest matching HTML, CSS, and JS hooks needed."
      : testVerificationRepair
        ? "Return only a repaired <changes> payload focused on the failing test or verification output. Preserve required behavioral test coverage; do not remove test files or drop assertions to pass validation. If a generated test asserts a field on the wrong public API shape, repair the test to assert through an existing returned object or supported accessor, or update the implementation only when the user request requires that API surface."
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
