export class FeedbackBotError extends Error {
  readonly code: string;

  constructor(message: string, code = "FEEDBACKBOT_ERROR", options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class ConfigError extends FeedbackBotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "CONFIG_ERROR", options);
  }
}

export class ValidationError extends FeedbackBotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "VALIDATION_ERROR", options);
  }
}

export class AbuseDetectedError extends FeedbackBotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "ABUSE_DETECTED", options);
  }
}

export class LLMError extends FeedbackBotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "LLM_ERROR", options);
  }
}

export class RateLimitError extends FeedbackBotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "RATE_LIMIT_ERROR", options);
  }
}

export class ExternalServiceError extends FeedbackBotError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "EXTERNAL_SERVICE_ERROR", options);
  }
}
