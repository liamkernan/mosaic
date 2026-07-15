import type Anthropic from "@anthropic-ai/sdk";
import { LLMError, type LLMKeyMode, type LLMProvider, logger } from "@mosaic/core";
import type OpenAI from "openai";

import { createAnthropicClient } from "./anthropic.js";
import { createOpenAIClient } from "./openai.js";
import { enforceRepoRateLimit } from "./rate-limiter.js";
import { trackUsage } from "./token-tracker.js";

export const ANTHROPIC_MODEL_IDS = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001"
} as const;

export const OPENAI_MODEL_IDS = {
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna"
} as const;

export const OPENAI_AUTOMATIC_TIMEOUT_FLOORS_MS = {
  [`${OPENAI_MODEL_IDS.sol}/high`]: 300_000,
  [`${OPENAI_MODEL_IDS.sol}/xhigh`]: 480_000
} as const;

export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const ANTHROPIC_ADVISOR_MODEL_ID = ANTHROPIC_MODEL_IDS.opus;
export const ANTHROPIC_ADVISOR_TOOL_BETA = "advisor-tool-2026-03-01";
export const ANTHROPIC_ADVISOR_MAX_TOKENS = 2_048;

const ANTHROPIC_ADVISOR_TOOL_TYPE = "advisor_20260301";
const ANTHROPIC_ADVISOR_TOOL_NAME = "advisor";
const ANTHROPIC_ADAPTIVE_REASONING_MODELS = new Set<string>([
  ANTHROPIC_MODEL_IDS.opus,
  ANTHROPIC_MODEL_IDS.sonnet
]);

export interface AdvisorToolOptions {
  model: string;
  maxUses?: number;
  maxTokens?: number;
}

export interface LLMClientOptions {
  provider?: LLMProvider;
  mode: LLMKeyMode;
  apiKey?: string;
  platformApiKey?: string;
  openAIBaseURL?: string;
  openAIMinOutputTokens?: number;
  openAIMinTimeoutMs?: number;
  model?: string;
  advisorTool?: AdvisorToolOptions;
  reasoningEffort?: OpenAIReasoningEffort;
  disableUsageTracking?: boolean;
  assertRequest?: (request: LLMRequestBoundaryAssertion) => void | Promise<void>;
  authorizeRequest?: (request: LLMRequestAuthorization) => string | void | Promise<string | void>;
  observeUsage?: (event: LLMUsageObservation) => void | Promise<void>;
}

export interface LLMRequestBoundaryAssertion {
  provider: LLMProvider;
  model: string;
  advisorModel?: string;
  systemPrompt: string;
  userMessage: string;
  requestPhase?: string;
}

export interface LLMRequestAuthorization {
  model: string;
  advisorModel?: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  advisorMaxTokens?: number;
}

export interface LLMUsageObservation {
  authorizationId?: string;
  requestPhase?: string;
  model: string;
  advisorModel?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  latencyMs: number;
  retries: number;
  advisorOffered: boolean;
  advisorUsed: boolean;
  advisorUnavailable: boolean;
  iterations: LLMUsageIteration[];
}

export interface LLMUsageIteration {
  type: "message" | "advisor_message";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  requestPhase?: string;
}

export interface UsageContext {
  repoFullName: string;
  feedbackId: string;
}

export class OpenAIOutputLimitError extends LLMError {
  readonly incompleteReason = "max_output_tokens" as const;

  constructor(outputTokens: number) {
    super(`OpenAI response incomplete: max_output_tokens after ${outputTokens} output tokens; partial output was discarded`);
  }
}

export class LLMRequestBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMRequestBoundaryError";
  }
}

export function isOpenAIOutputLimitError(error: unknown): error is OpenAIOutputLimitError {
  return error instanceof OpenAIOutputLimitError || (
    typeof error === "object" &&
    error !== null &&
    "incompleteReason" in error &&
    error.incompleteReason === "max_output_tokens"
  );
}

type TextContentBlock = {
  type: "text";
  text: string;
};

type AdvisorToolDefinition = {
  type: typeof ANTHROPIC_ADVISOR_TOOL_TYPE;
  name: typeof ANTHROPIC_ADVISOR_TOOL_NAME;
  model: string;
  max_uses?: number;
  max_tokens?: number;
};

type AnthropicErrorDetails = {
  status?: number;
  name?: string;
  message: string;
};

type BetaMessageStreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type AnthropicMessageResponse = Awaited<ReturnType<ReturnType<Anthropic["messages"]["stream"]>["finalMessage"]>>;
type AnthropicBetaMessageResponse = Awaited<ReturnType<ReturnType<Anthropic["beta"]["messages"]["stream"]>["finalMessage"]>>;
type AnthropicCompletionResponse = AnthropicMessageResponse | AnthropicBetaMessageResponse;

function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, provider = "Anthropic"): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new LLMError(`${provider} completion timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function buildAdvisorToolDefinition(options: AdvisorToolOptions): AdvisorToolDefinition {
  return {
    type: ANTHROPIC_ADVISOR_TOOL_TYPE,
    name: ANTHROPIC_ADVISOR_TOOL_NAME,
    model: options.model,
    ...(options.maxUses === undefined ? {} : { max_uses: options.maxUses }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens })
  };
}

function isTextContentBlock(item: unknown): item is TextContentBlock {
  return typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string";
}

function isAdvisorUseBlock(item: unknown): boolean {
  if (typeof item !== "object" || item === null || !("type" in item)) {
    return false;
  }
  const itemType = String(item.type);
  return (itemType === "server_tool_use" || itemType === "tool_use") &&
    "name" in item && item.name === ANTHROPIC_ADVISOR_TOOL_NAME;
}

function extractTextContent(content: unknown[]): string {
  let text = "";

  for (const item of content) {
    if (!isTextContentBlock(item)) {
      continue;
    }

    text = text.length === 0 ? item.text : `${text}\n${item.text}`;
  }

  return text;
}

function usageTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function extractUsageIterations(
  usage: AnthropicCompletionResponse["usage"],
  executorModel: string,
  advisorModel?: string,
  advisorUsed = false
): LLMUsageIteration[] {
  const extendedUsage = usage as typeof usage & { iterations?: unknown };
  if (!Array.isArray(extendedUsage.iterations) || extendedUsage.iterations.length === 0) {
    if (advisorUsed) {
      throw new LLMError("Anthropic omitted advisor usage iterations from an advisor-assisted response");
    }
    return [{
      type: "message",
      model: executorModel,
      inputTokens: usageTokenCount(usage.input_tokens),
      outputTokens: usageTokenCount(usage.output_tokens),
      cacheReadInputTokens: usageTokenCount("cache_read_input_tokens" in usage ? usage.cache_read_input_tokens : 0),
      cacheCreationInputTokens: usageTokenCount("cache_creation_input_tokens" in usage ? usage.cache_creation_input_tokens : 0)
    }];
  }

  const iterations = extendedUsage.iterations.map((rawIteration: unknown, index: number): LLMUsageIteration => {
    if (typeof rawIteration !== "object" || rawIteration === null || !("type" in rawIteration)) {
      throw new LLMError(`Anthropic returned malformed usage iteration at index ${index}`);
    }
    const iteration = rawIteration as Record<string, unknown>;
    if (iteration.type !== "message" && iteration.type !== "advisor_message") {
      throw new LLMError(`Anthropic returned unknown usage iteration type at index ${index}`);
    }
    const model = iteration.type === "message"
      ? executorModel
      : typeof iteration.model === "string" && iteration.model.length > 0
        ? iteration.model
        : advisorModel;
    if (!model) {
      throw new LLMError(`Anthropic omitted the advisor model from usage iteration ${index}`);
    }
    return {
      type: iteration.type,
      model,
      inputTokens: usageTokenCount(iteration.input_tokens),
      outputTokens: usageTokenCount(iteration.output_tokens),
      cacheReadInputTokens: usageTokenCount(iteration.cache_read_input_tokens),
      cacheCreationInputTokens: usageTokenCount(iteration.cache_creation_input_tokens)
    };
  });
  if (advisorUsed && !iterations.some((iteration: LLMUsageIteration) => iteration.type === "advisor_message")) {
    throw new LLMError("Anthropic omitted advisor usage iterations from an advisor-assisted response");
  }
  return iterations;
}

function getAnthropicErrorDetails(error: unknown): AnthropicErrorDetails {
  const statusValue = typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
  const nestedError = typeof error === "object" && error && "error" in error && typeof error.error === "object"
    ? error.error
    : undefined;
  const nestedMessage = nestedError && "message" in nestedError && typeof nestedError.message === "string"
    ? nestedError.message
    : undefined;
  const message = error instanceof Error ? error.message : String(error);

  return {
    status: statusValue && Number.isFinite(statusValue) ? statusValue : undefined,
    name: typeof error === "object" && error && "name" in error ? String(error.name) : undefined,
    message: nestedMessage && !message.includes(nestedMessage)
      ? `${message}: ${nestedMessage}`
      : message
  };
}

function shouldFallbackFromAdvisorError(error: unknown, advisorTool: AdvisorToolOptions): boolean {
  const { status, message } = getAnthropicErrorDetails(error);
  const normalized = message.toLowerCase();
  const mentionsAdvisorFeature = normalized.includes("advisor") ||
    normalized.includes("beta") ||
    normalized.includes("tool") ||
    normalized.includes(advisorTool.model.toLowerCase());
  const availabilityStatus = status === 400 || status === 403 || status === 404 || status === 429 || status === 529;
  const availabilityMessage = /\b(unavailable|not available|not found|permission|access|invalid|rate|overload|capacity)\b/i.test(message);

  return mentionsAdvisorFeature && (availabilityStatus || availabilityMessage);
}

function normalizeOpenAIReasoningEffort(model: string, reasoningEffort?: OpenAIReasoningEffort): OpenAIReasoningEffort | undefined {
  if (reasoningEffort === "none" && model === "gpt-5-mini") {
    return "minimal";
  }

  return reasoningEffort;
}

export function resolveOpenAIRequestTimeoutMs(
  model: string,
  reasoningEffort: OpenAIReasoningEffort | undefined,
  requestTimeoutMs: number | undefined,
  configuredMinTimeoutMs: number | undefined
): number | undefined {
  const routeFloorMs = reasoningEffort
    ? OPENAI_AUTOMATIC_TIMEOUT_FLOORS_MS[
        `${model}/${reasoningEffort}` as keyof typeof OPENAI_AUTOMATIC_TIMEOUT_FLOORS_MS
      ]
    : undefined;
  const candidates = [requestTimeoutMs, configuredMinTimeoutMs, routeFloorMs]
    .filter((value): value is number => value !== undefined);

  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

export class LLMClient {
  private readonly provider: LLMProvider;
  private readonly anthropicClient?: Anthropic;
  private readonly openaiClient?: OpenAI;
  private readonly openAIMinOutputTokens?: number;
  private readonly openAIMinTimeoutMs?: number;
  private readonly defaultModel: string;
  private readonly advisorTool?: AdvisorToolOptions;
  private readonly reasoningEffort?: OpenAIReasoningEffort;
  private readonly disableUsageTracking: boolean;
  private readonly assertRequest?: LLMClientOptions["assertRequest"];
  private readonly authorizeRequest?: LLMClientOptions["authorizeRequest"];
  private readonly observeUsage?: LLMClientOptions["observeUsage"];
  private usageContext?: UsageContext;

  constructor({
    provider = "anthropic",
    mode,
    apiKey,
    platformApiKey,
    openAIBaseURL,
    openAIMinOutputTokens,
    openAIMinTimeoutMs,
    model,
    advisorTool,
    reasoningEffort,
    disableUsageTracking = false,
    assertRequest,
    authorizeRequest,
    observeUsage
  }: LLMClientOptions) {
    const resolvedApiKey = mode === "byok" ? apiKey : platformApiKey;
    if (!resolvedApiKey) {
      throw new LLMError(`Missing API key for LLM mode: ${mode}`);
    }

    this.provider = provider;
    if (provider === "openai") {
      this.openaiClient = openAIBaseURL
        ? createOpenAIClient(resolvedApiKey, { baseURL: openAIBaseURL })
        : createOpenAIClient(resolvedApiKey);
    } else {
      this.anthropicClient = createAnthropicClient(resolvedApiKey);
    }
    this.openAIMinOutputTokens = provider === "openai" ? openAIMinOutputTokens : undefined;
    this.openAIMinTimeoutMs = provider === "openai" ? openAIMinTimeoutMs : undefined;
    this.defaultModel = model ?? (provider === "openai" ? OPENAI_MODEL_IDS.terra : ANTHROPIC_MODEL_IDS.sonnet);
    this.advisorTool = provider === "anthropic" ? advisorTool : undefined;
    this.reasoningEffort = reasoningEffort;
    this.disableUsageTracking = disableUsageTracking;
    this.assertRequest = assertRequest;
    this.authorizeRequest = authorizeRequest;
    this.observeUsage = observeUsage;
  }

  setUsageContext(context: UsageContext): void {
    this.usageContext = context;
  }

  private async completeWithOpenAI(
    systemPrompt: string,
    userMessage: string,
    options: CompletionOptions
  ): Promise<string> {
    if (!this.openaiClient) {
      throw new LLMError("OpenAI client is not initialized");
    }

    const maxRetries = 3;
    let attempt = 0;
    let requestAttempts = 0;
    const model = this.defaultModel;
    const reasoningEffort = normalizeOpenAIReasoningEffort(model, this.reasoningEffort);
    const maxOutputTokens = Math.max(options.maxTokens ?? 4096, this.openAIMinOutputTokens ?? 0);
    const timeoutMs = resolveOpenAIRequestTimeoutMs(
      model,
      reasoningEffort,
      options.timeoutMs,
      this.openAIMinTimeoutMs
    );
    const startedAt = Date.now();

    while (attempt < maxRetries) {
      try {
        if (this.usageContext && !this.disableUsageTracking) {
          await enforceRepoRateLimit(this.usageContext.repoFullName);
        }

        await this.assertRequest?.({
          provider: this.provider,
          model,
          systemPrompt,
          userMessage,
          ...(options.requestPhase ? { requestPhase: options.requestPhase } : {})
        });
        const authorizationId = await this.authorizeRequest?.({
          model,
          estimatedInputTokens: Math.ceil((systemPrompt.length + userMessage.length) / 3),
          maxOutputTokens
        });
        requestAttempts += 1;

        const requestOptions = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
        const response = await withHardTimeout(
          this.openaiClient.responses.create({
            model,
            instructions: systemPrompt,
            input: userMessage,
            max_output_tokens: maxOutputTokens,
            ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
            text: { verbosity: "low" },
            store: false
          }, requestOptions),
          timeoutMs,
          "OpenAI"
        );

        const inputTokens = response.usage?.input_tokens ?? 0;
        const outputTokens = response.usage?.output_tokens ?? 0;
        const cacheReadInputTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;

        if (this.usageContext && response.usage && !this.disableUsageTracking) {
          await trackUsage({
            ...this.usageContext,
            model,
            inputTokens,
            outputTokens,
            timestamp: Date.now()
          });
        }

        if (response.usage && this.observeUsage) {
          await this.observeUsage({
            ...(authorizationId ? { authorizationId } : {}),
            ...(options.requestPhase ? { requestPhase: options.requestPhase } : {}),
            model,
            inputTokens,
            outputTokens,
            cacheReadInputTokens,
            cacheCreationInputTokens: 0,
            latencyMs: Date.now() - startedAt,
            retries: Math.max(0, requestAttempts - 1),
            advisorOffered: false,
            advisorUsed: false,
            advisorUnavailable: false,
            iterations: [{
              type: "message",
              model,
              inputTokens,
              outputTokens,
              cacheReadInputTokens,
              cacheCreationInputTokens: 0
            }]
          });
        }

        if (response.status === "incomplete") {
          if (response.incomplete_details?.reason === "max_output_tokens") {
            throw new OpenAIOutputLimitError(outputTokens);
          }

          throw new LLMError(
            `OpenAI response incomplete: ${response.incomplete_details?.reason ?? "unknown reason"}; partial output was discarded`
          );
        }

        return response.output_text.trim();
      } catch (error) {
        if (error instanceof LLMRequestBoundaryError) {
          throw error;
        }
        attempt += 1;
        if (isOpenAIOutputLimitError(error)) {
          throw error;
        }
        const { status, name: errorName, message: errorMessage } = getAnthropicErrorDetails(error);
        if (status === 429 && attempt < maxRetries) {
          const delayMs = 2 ** attempt * 1_000;
          logger.warn({ attempt, delayMs, provider: "openai" }, "OpenAI rate limit hit, retrying");
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        const details = [status ? `status ${status}` : undefined, errorName, errorMessage]
          .filter(Boolean)
          .join(": ");
        throw new LLMError(details ? `OpenAI completion failed (${details})` : "OpenAI completion failed", {
          cause: error as Error
        });
      }
    }

    throw new LLMError("OpenAI completion failed after retries");
  }

  async complete(systemPrompt: string, userMessage: string, options: CompletionOptions = {}): Promise<string> {
    if (this.provider === "openai") {
      return this.completeWithOpenAI(systemPrompt, userMessage, options);
    }
    if (!this.anthropicClient) {
      throw new LLMError("Anthropic client is not initialized");
    }
    const maxRetries = 3;
    let attempt = 0;
    const model = this.defaultModel;
    let advisorUnavailable = false;
    let requestAttempts = 0;
    const startedAt = Date.now();

    const authorizeApiRequest = async (advisorTool?: AdvisorToolOptions): Promise<string | undefined> => {
      await this.assertRequest?.({
        provider: this.provider,
        model,
        ...(advisorTool ? { advisorModel: advisorTool.model } : {}),
        systemPrompt,
        userMessage,
        ...(options.requestPhase ? { requestPhase: options.requestPhase } : {})
      });
      const authorizationId = await this.authorizeRequest?.({
        model,
        ...(advisorTool ? { advisorModel: advisorTool.model } : {}),
        ...(advisorTool?.maxTokens === undefined ? {} : { advisorMaxTokens: advisorTool.maxTokens }),
        estimatedInputTokens: Math.ceil((systemPrompt.length + userMessage.length) / 3),
        maxOutputTokens: options.maxTokens ?? 4096
      });
      requestAttempts += 1;
      return authorizationId || undefined;
    };

    while (attempt < maxRetries) {
      try {
        if (this.usageContext && !this.disableUsageTracking) {
          await enforceRepoRateLimit(this.usageContext.repoFullName);
        }

        const request = {
          model,
          system: systemPrompt,
          max_tokens: options.maxTokens ?? 4096,
          ...(ANTHROPIC_ADAPTIVE_REASONING_MODELS.has(model) ? {} : { temperature: options.temperature ?? 0.2 }),
          messages: [{ role: "user" as const, content: userMessage }]
        };
        const requestOptions = options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined;
        const advisorTool = advisorUnavailable ? undefined : this.advisorTool;
        let response: AnthropicCompletionResponse;
        let authorizationId: string | undefined;

        if (advisorTool) {
          try {
            authorizationId = await authorizeApiRequest(advisorTool);
            const advisorStream = this.anthropicClient.beta.messages.stream(
              {
                ...request,
                betas: [ANTHROPIC_ADVISOR_TOOL_BETA],
                tools: [buildAdvisorToolDefinition(advisorTool)]
              } as unknown as BetaMessageStreamParams,
              requestOptions
            );
            response = await withHardTimeout(advisorStream.finalMessage(), options.timeoutMs);
          } catch (error) {
            if (!shouldFallbackFromAdvisorError(error, advisorTool)) {
              throw error;
            }

            advisorUnavailable = true;
            const { status, name, message } = getAnthropicErrorDetails(error);
            logger.warn(
              {
                status,
                name,
                executorModel: model,
                advisorModel: advisorTool.model,
                errorMessage: message
              },
              "Advisor tool unavailable, retrying Anthropic completion without advisor"
            );

            authorizationId = await authorizeApiRequest();
            const fallbackStream = this.anthropicClient.messages.stream(request, requestOptions);
            response = await withHardTimeout(fallbackStream.finalMessage(), options.timeoutMs);
          }
        } else {
          authorizationId = await authorizeApiRequest();
          const stream = this.anthropicClient.messages.stream(request, requestOptions);
          response = await withHardTimeout(stream.finalMessage(), options.timeoutMs);
        }

        const text = extractTextContent(response.content);

        if (this.usageContext && response.usage && !this.disableUsageTracking) {
          await trackUsage({
            ...this.usageContext,
            model,
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            timestamp: Date.now()
          });
        }

        if (response.usage && this.observeUsage) {
          const usage = response.usage as typeof response.usage & {
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          const advisorUsed = response.content.some(isAdvisorUseBlock);
          await this.observeUsage({
            ...(authorizationId ? { authorizationId } : {}),
            ...(options.requestPhase ? { requestPhase: options.requestPhase } : {}),
            model,
            ...(this.advisorTool ? { advisorModel: this.advisorTool.model } : {}),
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
            latencyMs: Date.now() - startedAt,
            retries: Math.max(0, requestAttempts - 1),
            advisorOffered: this.advisorTool !== undefined,
            advisorUsed,
            advisorUnavailable,
            iterations: extractUsageIterations(usage, model, this.advisorTool?.model, advisorUsed)
          });
        }

        if (response.stop_reason === "refusal") {
          throw new LLMError("Anthropic completion was refused by the model safety system");
        }

        return text.trim();
      } catch (error) {
        if (error instanceof LLMRequestBoundaryError) {
          throw error;
        }
        attempt += 1;
        const { status, name: errorName, message: errorMessage } = getAnthropicErrorDetails(error);
        if (status === 429 && attempt < maxRetries) {
          const delayMs = 2 ** attempt * 1_000;
          logger.warn({ attempt, delayMs }, "Anthropic rate limit hit, retrying");
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        const details = [
          status ? `status ${status}` : undefined,
          errorName,
          errorMessage
        ].filter(Boolean).join(": ");

        throw new LLMError(details ? `Anthropic completion failed (${details})` : "Anthropic completion failed", {
          cause: error as Error
        });
      }
    }

    throw new LLMError("Anthropic completion failed after retries");
  }
}
