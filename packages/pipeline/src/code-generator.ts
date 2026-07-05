import { LLMError, type ClassifiedFeedback, type GeneratedChange, type RelevantFile } from "@mosaic/core";
import { isOpenAIOutputLimitError } from "@mosaic/llm";

import { parseGeneratedChanges } from "./generated-change-parser.js";
import type { PipelineLlmClient } from "./pipeline-llm-client.js";
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
const COMPACT_SOURCE_FILE_BYTES = 24_000;
const COMPACT_CONTEXT_TOTAL_BYTES = 80_000;
const STATIC_FRONTEND_RETRY_MAX_TOKENS = 8_192;
const VALIDATION_REPAIR_TIMEOUT_MS = 120_000;
const VALIDATION_REPAIR_MAX_TOKENS = 12_288;
const EDIT_REANCHOR_EXCERPT_CHARS = 12_000;
export const scopeValidationPattern = /outside the implementation plan scope/i;

interface GenerationOptions {
  completeSolution?: boolean;
}

interface PromptFileOptions {
  compactAssetBytes: number;
  compactHtml?: boolean;
  keywords?: string[];
}

const fileByteLengthCache = new WeakMap<RelevantFile, { content: string; byteLength: number }>();
const keywordPattern = /[a-z][a-z0-9-]{3,}/g;
const keywordStopwords = new Set(["about", "add", "and", "for", "from", "into", "make", "open", "that", "the", "them", "this", "with"]);

function fileContentByteLength(file: RelevantFile): number {
  const cached = fileByteLengthCache.get(file);
  if (cached?.content === file.content) {
    return cached.byteLength;
  }

  const byteLength = Buffer.byteLength(file.content);
  fileByteLengthCache.set(file, { content: file.content, byteLength });
  return byteLength;
}

function buildEditReanchorPrompt(
  response: string,
  error: LLMError,
  relevantFiles: RelevantFile[]
): string {
  const excerpts = relevantFiles.map((file) =>
    `--- CURRENT ${file.path} ---\n${file.content.slice(0, EDIT_REANCHOR_EXCERPT_CHARS)}\n--- END ${file.path} ---`
  ).join("\n\n");
  return `A structured edit could not be applied atomically.

STRUCTURED EDIT APPLICATION ERROR:
${error.message}

REJECTED PAYLOAD:
${response}

CURRENT BOUNDED FILE EXCERPTS:
${excerpts}

Return a corrected <changes> payload. Operations are applied atomically in response order to an in-memory working copy. Every search block must match the current version of its file exactly once at that point in the response. Use a larger unique anchor when the old search matched multiple locations. If a bounded excerpt contains the whole file, a complete modifiedContent replacement is allowed. Preserve all unrelated content and changes.`;
}

function estimateGenerationMaxTokens(relevantFiles: RelevantFile[], options: GenerationOptions = {}): number {
  const totalBytes = relevantFiles.reduce((sum, file) => sum + fileContentByteLength(file), 0);
  const estimatedTokens = Math.ceil(totalBytes / 3) + (options.completeSolution ? 8_192 : 2_048);
  const floor = options.completeSolution ? 8_192 : 4_096;
  const ceiling = options.completeSolution ? 32_768 : 16_384;
  return Math.max(floor, Math.min(ceiling, estimatedTokens));
}

function isStaticFrontendFile(filePath: string): boolean {
  return /\.(?:html?|css|[cm]?js)$/i.test(filePath);
}

function totalStaticFrontendBytes(relevantFiles: RelevantFile[]): number {
  let totalBytes = 0;

  for (const file of relevantFiles) {
    if (isStaticFrontendFile(file.path)) {
      totalBytes += fileContentByteLength(file);
    }
  }

  return totalBytes;
}

function shouldCompactStaticFrontendContext(relevantFiles: RelevantFile[]): boolean {
  return totalStaticFrontendBytes(relevantFiles) > LARGE_STATIC_FRONTEND_BYTES;
}

function shouldRetryStaticFrontendGeneration(relevantFiles: RelevantFile[], error: unknown): boolean {
  if (isOpenAIOutputLimitError(error)) {
    return relevantFiles.some((file) => isStaticFrontendFile(file.path));
  }

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
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const match of text.toLowerCase().matchAll(keywordPattern)) {
    const word = match[0];
    if (keywordStopwords.has(word) || seen.has(word)) {
      continue;
    }

    seen.add(word);
    keywords.push(word);
    if (keywords.length >= 12) {
      return keywords;
    }
  }

  return keywords;
}

function promptKeywordText(feedback: ClassifiedFeedback, implementationPlan?: ImplementationPlan, validationErrors: string[] = []): string {
  return [
    feedback.summary,
    feedback.rawContent,
    implementationPlan?.requiredFiles.map((file) => `${file.path} ${file.reason}`).join("\n"),
    implementationPlan?.acceptanceCriteria.join("\n"),
    implementationPlan?.implementationChecklist.join("\n"),
    validationErrors.join("\n")
  ].filter(Boolean).join("\n");
}

function totalPromptFileBytes(relevantFiles: RelevantFile[]): number {
  return relevantFiles.reduce((sum, file) => sum + fileContentByteLength(file), 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldCompactPromptContext(relevantFiles: RelevantFile[]): boolean {
  let totalBytes = 0;
  let staticFrontendBytes = 0;

  for (const file of relevantFiles) {
    const byteLength = fileContentByteLength(file);
    totalBytes += byteLength;
    if (isStaticFrontendFile(file.path)) {
      staticFrontendBytes += byteLength;
    }

    if (
      staticFrontendBytes > LARGE_STATIC_FRONTEND_BYTES ||
      totalBytes > COMPACT_CONTEXT_TOTAL_BYTES ||
      byteLength > COMPACT_SOURCE_FILE_BYTES
    ) {
      return true;
    }
  }

  return false;
}

function keywordLineIndexes(lines: string[], keywords: string[], limit: number): number[] {
  if (keywords.length === 0) {
    return [];
  }

  const keywordPattern = new RegExp(keywords.map(escapeRegExp).join("|"), "i");
  const indexes: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (keywordPattern.test(lines[index])) {
      indexes.push(index);
      if (indexes.length >= limit) {
        break;
      }
    }
  }

  return indexes;
}

function compactHtmlContent(file: RelevantFile, options: PromptFileOptions): RelevantFile {
  if (!options.compactHtml || !/\.html?$/i.test(file.path) || fileContentByteLength(file) <= options.compactAssetBytes) {
    return file;
  }

  const lines = file.content.split("\n");
  const headLines = options.compactAssetBytes <= RETRY_COMPACT_STATIC_ASSET_BYTES ? 40 : 80;
  const tailLines = options.compactAssetBytes <= RETRY_COMPACT_STATIC_ASSET_BYTES ? 30 : 60;
  const keywords = options.keywords ?? [];
  const matchedIndexes = keywordLineIndexes(lines, keywords, 8);
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

function lineCommentForPath(filePath: string): string {
  if (/\.(?:html?|mdx?|xml|svg)$/i.test(filePath)) {
    return "<!--";
  }

  if (/\.(?:py|rb|sh|ya?ml|toml)$/i.test(filePath)) {
    return "#";
  }

  return "//";
}

function formatOmittedLineNote(filePath: string, omittedLineCount: number): string {
  const commentStart = lineCommentForPath(filePath);
  if (commentStart === "<!--") {
    return `<!-- MOSAIC CONTEXT NOTE: ${omittedLineCount} middle line(s) of ${filePath} omitted from prompt context. -->`;
  }

  return `${commentStart} MOSAIC CONTEXT NOTE: ${omittedLineCount} middle line(s) of ${filePath} omitted from prompt context.`;
}

function compactLargeSourceContent(file: RelevantFile, options: PromptFileOptions): RelevantFile {
  const byteLength = fileContentByteLength(file);
  if (byteLength <= COMPACT_SOURCE_FILE_BYTES || /\.(?:css|html?|[cm]?js)$/i.test(file.path)) {
    return file;
  }

  const lines = file.content.split("\n");
  const headLines = 120;
  const tailLines = 80;
  const keywords = options.keywords ?? [];
  const matchedIndexes = keywordLineIndexes(lines, keywords, 10);
  const includedIndexes = new Set<number>();

  for (let index = 0; index < Math.min(headLines, lines.length); index += 1) {
    includedIndexes.add(index);
  }

  for (const matchIndex of matchedIndexes) {
    for (let index = Math.max(0, matchIndex - 12); index <= Math.min(lines.length - 1, matchIndex + 18); index += 1) {
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
        ? `\n${formatOmittedLineNote(file.path, index - previous - 1)}\n`
        : "";
      return `${prefix}${lines[index]}`;
    })
    .join("\n");

  return {
    ...file,
    content: `${excerpt}\n\n${formatOmittedLineNote(file.path, Math.max(0, lines.length - includedIndexes.size))}`,
    reason: `${file.reason}; compacted oversized source context`
  };
}

function compactFileContent(file: RelevantFile, options: PromptFileOptions): RelevantFile {
  const htmlCompacted = compactHtmlContent(file, options);
  if (htmlCompacted !== file) {
    return htmlCompacted;
  }

  if (!/\.(?:css|[cm]?js)$/i.test(file.path) || fileContentByteLength(file) <= options.compactAssetBytes) {
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
  if (!shouldCompactPromptContext(relevantFiles)) {
    return relevantFiles;
  }

  return relevantFiles.map((file) => compactLargeSourceContent(compactFileContent(file, options), options));
}

function retryPromptRelevantFiles(relevantFiles: RelevantFile[], keywords: string[], forceCompact = false): RelevantFile[] {
  let shouldCompact = forceCompact;
  let totalStaticBytes = 0;
  for (const file of relevantFiles) {
    if (isStaticFrontendFile(file.path)) {
      totalStaticBytes += fileContentByteLength(file);
      if (!shouldCompact && totalStaticBytes > STATIC_FRONTEND_RETRY_BYTES) {
        shouldCompact = true;
        break;
      }
    }
  }

  if (!shouldCompact) {
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

function hasSyntaxValidationError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /Syntax validation failed/i.test(error));
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

function hasMissingFrontendLayerError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /\[missing-frontend-layer:(?:html|javascript|css)\]/i.test(error));
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

function hasScopeValidationError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => scopeValidationPattern.test(error));
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

function hasTestIntegrityError(validationErrors: string[]): boolean {
  return validationErrors.some((error) => /weakens existing test assertions|skipped or trivial test assertions/i.test(error));
}

interface ValidationRepairRoute {
  match: (validationErrors: string[]) => boolean;
  instruction: string;
  maxTokens: (promptFiles: RelevantFile[]) => number;
  timeoutMs: number;
}

function focusedValidationRepairMaxTokens(promptFiles: RelevantFile[]): number {
  return Math.min(estimateGenerationMaxTokens(promptFiles, { completeSolution: false }), VALIDATION_REPAIR_MAX_TOKENS);
}

const VALIDATION_REPAIR_ROUTES: ValidationRepairRoute[] = [
  {
    match: hasScopeValidationError,
    instruction: "Return only a corrected <changes> payload that removes every file outside the implementation plan scope. Keep the necessary implementation and focused companion test/config/asset edits, but do not include unrelated files from other packages, examples, docs, or apps unless they are explicitly listed in the implementation plan.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasOversizedPatchValidationError,
    instruction: "Return only a compact repaired <changes> payload. The previous patch exceeded validation limits, so remove repeated markup/data and use one reusable data-driven implementation with matching JS/CSS.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasSyntaxValidationError,
    instruction: "Return only a repaired <changes> payload focused on syntax validity. Fix the reported parser error in the changed source file while preserving the intended behavior, existing tests, and public API. Do not remove the affected feature or weaken tests to make parsing pass.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasMissingFrontendLayerError,
    instruction: "Return only a repaired <changes> payload that preserves the useful current changes and adds every missing frontend layer named by validation. Modify the planned HTML, JavaScript, and CSS files together as a complete implementation: HTML hooks must match JavaScript selectors, interactive behavior must be keyboard accessible, and CSS must style the exact classes/ids used by the markup. Do not omit an existing layer or add files outside the implementation plan.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasMissingHtmlHookValidationError,
    instruction: "Return only a repaired <changes> payload focused on mismatched HTML and JavaScript hooks. Add the exact missing ids/classes/data attributes to the HTML, or retarget the script to hooks that already exist. If the target is a non-native card, use a native button or link where possible; otherwise add role, tabindex, and Enter and Space keyboard handling in the same repair. Do not merely add a clickable class to a div/article/section. Include both HTML and JS edits when needed; do not leave selectors that match nothing.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasMissingBehavioralTestCoverageError,
    instruction: "Return only a repaired <changes> payload focused on missing behavioral test coverage. Keep the implementation changes and add or update a focused test/spec file already present in the repository or required by the implementation plan; do not return an implementation-only repair.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasMissingIdempotencyUpdateError,
    instruction: "Return only a repaired <changes> payload focused on the missing idempotent duplicate/retry update path. Include an implementation edit, not tests only. In the create/insert path, normalize the stated source/key inputs, look up an existing open record by the idempotency key before INSERT/create, UPDATE that existing record and return it with the same id when found, add any expected audit/update side effects, and preserve normal distinct creation when the key is absent or different. Use a full-file <change> when a localized search/replace is risky.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasTestApiShapeMismatchError,
    instruction: "Return only a repaired <changes> payload focused on the test/API shape mismatch. If a generated test reads a field from a list/query/API result that the implementation does not expose, either update the implementation to expose that field when it is part of the requested public behavior, or repair the test to assert through an existing returned object or supported accessor. Preserve behavioral coverage; do not delete assertions just to pass validation.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasMissingPythonImportError,
    instruction: "Return only a repaired <changes> payload focused on the missing Python import. Preserve the implementation and tests; update the caller module import or qualified reference so every newly called sibling-module helper is actually imported or defined.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasMissingEndpointRouteError,
    instruction: "Return only a repaired <changes> payload focused on the missing endpoint route. Preserve the service/helper implementation and tests; update the routing or handler surface so the exact requested HTTP path is handled and returns the requested response instead of falling through to not found.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasMissingRuntimeChangeError,
    instruction: "Return only a repaired <changes> payload focused on the missing runtime/source implementation. Preserve useful tests and documentation, but add or update the actual application source files named by the implementation plan so the user's reported behavior changes in the running software; do not return tests/docs-only repairs.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasMissingInteractiveBehaviorValidationError,
    instruction: "Return only a repaired <changes> payload focused on missing interactive behavior. Add or update JavaScript that opens, populates, closes, and keyboard-wires the modal/dialog/overlay using the exact new markup ids/classes/data attributes; do not return HTML/CSS-only repairs.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasFrontendVerificationFailure,
    instruction: "Return only a repaired <changes> payload focused on the failing frontend verification assertions. Treat the reported selectors, ids, classes, text, attributes, counts, and runtime errors as binding executable contracts. Map existing generated elements to the required selector alternatives before redesigning the implementation. For an exact compound selector such as .card-clickable[data-key], add every required class and data attribute to the same interactive element. Prefer a native button or link; otherwise include role, tabindex, and Enter and Space keyboard handling. Update the smallest matching HTML, CSS, and JS hooks needed and preserve unrelated page content.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasTestVerificationFailure,
    instruction: "Return only a repaired <changes> payload focused on the failing test or verification output. Preserve required behavioral test coverage; do not remove test files or drop assertions to pass validation. If a generated test asserts a field on the wrong public API shape, repair the test to assert through an existing returned object or supported accessor, or update the implementation only when the user request requires that API surface.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  },
  {
    match: hasTestIntegrityError,
    instruction: "Return only a repaired <changes> payload focused on test integrity. Do not skip tests, replace assertions with trivial truth checks, or weaken existing reported coverage. Restore the original meaningful assertions and fix the application implementation so those assertions pass.",
    maxTokens: focusedValidationRepairMaxTokens,
    timeoutMs: VALIDATION_REPAIR_TIMEOUT_MS
  }
];

export class CodeGenerator {
  constructor(private readonly llmClient: PipelineLlmClient) {}

  private toGeneratedChanges(
    parsed: Array<{ filePath: string; modifiedContent?: string; search?: string; replace?: string; explanation: string }>,
    relevantFiles: RelevantFile[]
  ): GeneratedChange[] {
    const originals = new Map<string, string>();
    for (const file of relevantFiles) {
      originals.set(file.path, file.content);
    }

    const workingFiles = new Map<string, {
      originalContent: string;
      modifiedContent: string;
      explanations: string[];
    }>();

    for (const change of parsed) {
      const existing = workingFiles.get(change.filePath);
      const originalContent = existing?.originalContent ?? originals.get(change.filePath) ?? "";
      const currentContent = existing?.modifiedContent ?? originalContent;
      let nextContent: string;
      if (change.modifiedContent !== undefined) {
        nextContent = change.modifiedContent;
      } else {
        if (change.search === undefined || change.replace === undefined) {
          throw new LLMError(`Change for ${change.filePath} did not include modifiedContent or search/replace edit`);
        }

        if (!existing && !originals.has(change.filePath)) {
          throw new LLMError(`Search/replace edit cannot create new file ${change.filePath}`);
        }

        const firstIndex = currentContent.indexOf(change.search);
        if (firstIndex === -1) {
          throw new LLMError(`Search block for ${change.filePath} was not found exactly once`);
        }

        if (currentContent.indexOf(change.search, firstIndex + change.search.length) !== -1) {
          throw new LLMError(`Search block for ${change.filePath} matched more than once`);
        }

        nextContent = currentContent.slice(0, firstIndex) + change.replace + currentContent.slice(firstIndex + change.search.length);
      }

      const explanations = existing?.explanations ?? [];
      if (currentContent !== nextContent && !explanations.includes(change.explanation)) {
        explanations.push(change.explanation);
      }
      workingFiles.set(change.filePath, {
        originalContent,
        modifiedContent: nextContent,
        explanations
      });
    }

    return [...workingFiles.entries()].flatMap(([filePath, file]) =>
      file.originalContent === file.modifiedContent
        ? []
        : [{
            filePath,
            originalContent: file.originalContent,
            modifiedContent: file.modifiedContent,
            explanation: file.explanations
              .map((explanation, index) => index === file.explanations.length - 1
                ? explanation
                : explanation.replace(/[.;]\s*$/, ""))
              .join("; ")
          }]
    );
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

    const promptFiles = promptRelevantFiles(relevantFiles, {
      compactAssetBytes: COMPACT_STATIC_ASSET_BYTES,
      keywords: extractKeywords(promptKeywordText(feedback, implementationPlan))
    });
    const maxTokens = estimateGenerationMaxTokens(promptFiles, options);
    const generationTimeoutMs = shouldCompactStaticFrontendContext(relevantFiles)
      ? STATIC_FRONTEND_GENERATION_TIMEOUT_MS
      : GENERATION_TIMEOUT_MS;

    let response;
    try {
      response = await this.llmClient.complete(
        buildGenerationPrompt(feedback.summary, promptFiles, fileTree, implementationPlan, options),
        "Return only the <changes> payload; use exact <edit> blocks for existing files and complete CDATA content only for new files or changes that cannot be expressed safely as localized edits.",
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

      const outputLimitReached = isOpenAIOutputLimitError(error);
      const retryFiles = retryPromptRelevantFiles(
        relevantFiles,
        extractKeywords(promptKeywordText(feedback, implementationPlan)),
        outputLimitReached
      );
      const retryReason = outputLimitReached
        ? "hit the OpenAI max_output_tokens limit"
        : "timed out";
      response = await this.llmClient.complete(
        buildGenerationPrompt(feedback.summary, retryFiles, fileTree, implementationPlan, options),
        `The previous static frontend generation ${retryReason}. Return only a compact, complete <changes> payload: prefer exact <edit> blocks or new scoped supplemental JS/CSS files linked from HTML. Do not rewrite full existing HTML/CSS/JS files. Implement one reusable data-driven modal/dialog and matching behavior/styles.`,
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

    try {
      return this.toGeneratedChanges(parsed, relevantFiles);
    } catch (error) {
      if (!(error instanceof LLMError) || !error.message.startsWith("Search block for ")) {
        throw error;
      }

      const reanchoredResponse = await this.llmClient.complete(
        buildEditReanchorPrompt(response, error, relevantFiles),
        "Return only the corrected <changes> payload with uniquely anchored edits or validated complete file contents.",
        {
          temperature: 0,
          maxTokens,
          timeoutMs: GENERATION_TIMEOUT_MS
        }
      );
      return this.toGeneratedChanges(parseGeneratedChanges(reanchoredResponse), relevantFiles);
    }
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

    const promptFiles = promptRelevantFiles(relevantFiles, {
      compactAssetBytes: COMPACT_STATIC_ASSET_BYTES,
      keywords: extractKeywords(promptKeywordText(feedback, implementationPlan, validationErrors))
    });
    const repairRoute = VALIDATION_REPAIR_ROUTES.find((route) => route.match(validationErrors));
    const maxTokens = repairRoute?.maxTokens(promptFiles) ?? estimateGenerationMaxTokens(promptFiles, options);
    const userMessage = repairRoute?.instruction ?? "Return only the repaired <changes> payload with complete file contents in CDATA blocks.";
    const response = await this.llmClient.complete(
      buildValidationRepairPrompt(feedback.summary, promptFiles, currentChanges, validationErrors, fileTree, implementationPlan),
      userMessage,
      {
        temperature: 0,
        maxTokens,
        timeoutMs: repairRoute?.timeoutMs ?? GENERATION_TIMEOUT_MS
      }
    );

    return this.toGeneratedChanges(parseGeneratedChanges(response), relevantFiles);
  }
}
