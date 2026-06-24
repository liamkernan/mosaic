import { createHash } from "node:crypto";

import { ConfigError, repoFullNamePattern, ValidationError } from "@mosaic/core";

const DEFAULT_MIN_SUBMIT_MS = 1_200;
const MAX_MIN_SUBMIT_MS = 10_000;
const embedKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;

export interface FormEmbedConfig {
  embedKey: string;
  repoFullName: string;
  allowedOrigins: string[];
  displayName?: string;
  requireEmail: boolean;
  minSubmitMs: number;
}

interface RawFormEmbedConfig {
  embedKey?: unknown;
  key?: unknown;
  repoFullName?: unknown;
  allowedOrigins?: unknown;
  displayName?: unknown;
  requireEmail?: unknown;
  minSubmitMs?: unknown;
}

let cachedRawFormEmbeds: string | undefined;
let cachedFormEmbedConfigs: FormEmbedConfig[] | undefined;
let cachedFormEmbedConfigByKey: Map<string, FormEmbedConfig> | undefined;

export interface EmbedBotFields {
  honeypot?: unknown;
  loadedAt?: unknown;
}

export function getFormEmbedConfigs(): FormEmbedConfig[] {
  return cachedFormEmbedConfigsForEnv().map(cloneFormEmbedConfig);
}

function cachedFormEmbedConfigsForEnv(): FormEmbedConfig[] {
  const rawConfig = process.env.MOSAIC_FORM_EMBEDS;
  if (cachedFormEmbedConfigs && cachedRawFormEmbeds === rawConfig) {
    return cachedFormEmbedConfigs;
  }

  const trimmedRawConfig = rawConfig?.trim();
  const normalizedRawConfig = trimmedRawConfig && trimmedRawConfig.length > 0 ? trimmedRawConfig : undefined;
  const configs = parseFormEmbedConfigs(normalizedRawConfig);
  cachedRawFormEmbeds = rawConfig;
  cachedFormEmbedConfigs = configs;
  cachedFormEmbedConfigByKey = new Map(configs.map((config) => [config.embedKey, config]));
  return configs;
}

function cloneFormEmbedConfig(config: FormEmbedConfig): FormEmbedConfig {
  return {
    ...config,
    allowedOrigins: [...config.allowedOrigins]
  };
}

export function parseFormEmbedConfigs(rawConfig: string | undefined): FormEmbedConfig[] {
  if (!rawConfig) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS must be valid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  if (!Array.isArray(parsed)) {
    throw new ConfigError("MOSAIC_FORM_EMBEDS must be a JSON array");
  }

  const seen = new Set<string>();
  return parsed.map((entry, index) => normalizeEmbedConfig(entry, index, seen));
}

export function findFormEmbedConfig(embedKey: string): FormEmbedConfig {
  cachedFormEmbedConfigsForEnv();
  const config = cachedFormEmbedConfigByKey?.get(embedKey);
  if (!config) {
    throw new ValidationError("Unknown feedback form embed key");
  }

  return cloneFormEmbedConfig(config);
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    return false;
  }

  if (allowedOrigins.includes("*")) {
    return true;
  }

  const normalizedOrigin = normalizedOriginValue(origin);
  return normalizedOrigin !== undefined && allowedOrigins.includes(normalizedOrigin);
}

export function assertEmbedOriginAllowed(origin: string | undefined, config: FormEmbedConfig): void {
  if (!isOriginAllowed(origin, config.allowedOrigins)) {
    throw new ValidationError("Feedback form origin is not allowed for this embed key");
  }
}

export function assertEmbedBotFields(fields: EmbedBotFields, now = Date.now(), minSubmitMs = DEFAULT_MIN_SUBMIT_MS): void {
  if (typeof fields.honeypot === "string" && fields.honeypot.trim().length > 0) {
    throw new ValidationError("Feedback form rejected by bot protection");
  }

  const loadedAt = typeof fields.loadedAt === "number" ? fields.loadedAt : Number(fields.loadedAt);
  if (!Number.isFinite(loadedAt)) {
    throw new ValidationError("Feedback form is missing bot protection metadata");
  }

  if (now - loadedAt < minSubmitMs) {
    throw new ValidationError("Feedback form was submitted too quickly");
  }
}

export function buildAnonymousSenderIdentifier(embedKey: string, ipAddress: string): string {
  const digest = createHash("sha256")
    .update(`${embedKey}:${ipAddress}`)
    .digest("hex")
    .slice(0, 16);

  return `anonymous-web:${embedKey}:${digest}`;
}

export function renderEmbedScript(config: FormEmbedConfig, submitPath = "/webhook/form/embed"): string {
  const publicConfig = {
    embedKey: config.embedKey,
    displayName: config.displayName ?? "Feedback",
    requireEmail: config.requireEmail,
    submitPath
  };

  return `(() => {
  const config = ${JSON.stringify(publicConfig)};
  const script = document.currentScript;
  const baseUrl = new URL(script?.src || window.location.href).origin;
  const mountSelector = script?.dataset.mosaicMount;
  const mode = script?.dataset.mosaicMode || (mountSelector ? "inline" : "floating");
  const accent = script?.dataset.mosaicAccent || "#2563eb";
  const loadedAt = Date.now();

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === "className") node.className = value;
      else if (key === "textContent") node.textContent = value;
      else node.setAttribute(key, String(value));
    }
    for (const child of children) node.append(child);
    return node;
  }

  function buildForm() {
    const form = el("form", { className: "mosaic-feedback-form" });
    const email = el("input", {
      className: "mosaic-feedback-input",
      type: "email",
      name: "senderEmail",
      autocomplete: "email",
      placeholder: config.requireEmail ? "Email address" : "Email address (optional)",
      required: config.requireEmail ? "required" : undefined
    });
    const message = el("textarea", {
      className: "mosaic-feedback-textarea",
      name: "message",
      minlength: "3",
      maxlength: "5000",
      rows: "5",
      required: "required",
      placeholder: "Share feedback, a bug, or a small improvement request"
    });
    const honeypot = el("input", {
      className: "mosaic-feedback-hp",
      type: "text",
      name: "website",
      tabindex: "-1",
      autocomplete: "off",
      "aria-hidden": "true"
    });
    const status = el("div", { className: "mosaic-feedback-status", role: "status", "aria-live": "polite" });
    const submit = el("button", { className: "mosaic-feedback-submit", type: "submit", textContent: "Send feedback" });
    form.append(email, message, honeypot, submit, status);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = "";
      try {
        const response = await fetch(new URL(config.submitPath, baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            embedKey: config.embedKey,
            senderEmail: email.value.trim() || undefined,
            message: message.value,
            honeypot: honeypot.value,
            loadedAt,
            pageUrl: window.location.href
          })
        });
        if (!response.ok) throw new Error("Feedback could not be sent");
        form.reset();
        status.textContent = "Feedback sent.";
      } catch {
        status.textContent = "Could not send feedback. Try again in a moment.";
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function injectStyles(root) {
    const style = el("style", { textContent: \`
      .mosaic-feedback-root { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; }
      .mosaic-feedback-panel { box-sizing: border-box; width: min(100%, 360px); background: #ffffff; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 16px 40px rgba(17, 24, 39, 0.18); padding: 14px; }
      .mosaic-feedback-title { margin: 0 0 10px; font-size: 15px; line-height: 1.3; font-weight: 650; }
      .mosaic-feedback-form { display: grid; gap: 10px; }
      .mosaic-feedback-input, .mosaic-feedback-textarea { box-sizing: border-box; width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; color: #111827; background: #ffffff; font: inherit; font-size: 14px; line-height: 1.4; padding: 9px 10px; }
      .mosaic-feedback-textarea { resize: vertical; min-height: 112px; }
      .mosaic-feedback-submit, .mosaic-feedback-toggle { border: 0; border-radius: 6px; background: \${accent}; color: #ffffff; cursor: pointer; font: inherit; font-size: 14px; font-weight: 650; line-height: 1; padding: 10px 12px; }
      .mosaic-feedback-submit:disabled { cursor: wait; opacity: 0.7; }
      .mosaic-feedback-status { min-height: 18px; font-size: 13px; line-height: 1.4; color: #475569; }
      .mosaic-feedback-hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; opacity: 0; }
      .mosaic-feedback-floating { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; display: grid; justify-items: end; gap: 10px; }
      .mosaic-feedback-floating .mosaic-feedback-panel[hidden] { display: none; }
      @media (max-width: 480px) {
        .mosaic-feedback-floating { left: 12px; right: 12px; bottom: 12px; }
        .mosaic-feedback-panel { width: 100%; }
      }
    \` });
    root.append(style);
  }

  function mount() {
    const host = mountSelector ? document.querySelector(mountSelector) : null;
    const root = el("div", { className: "mosaic-feedback-root" });
    injectStyles(root);
    const panel = el("section", { className: "mosaic-feedback-panel", "aria-label": config.displayName });
    panel.append(el("p", { className: "mosaic-feedback-title", textContent: config.displayName }), buildForm());

    if (mode === "floating") {
      root.className += " mosaic-feedback-floating";
      panel.hidden = true;
      const toggle = el("button", { className: "mosaic-feedback-toggle", type: "button", textContent: config.displayName });
      toggle.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
      });
      root.append(panel, toggle);
      document.body.append(root);
      return;
    }

    root.append(panel);
    (host || document.body).append(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();`;
}

function normalizeEmbedConfig(rawEntry: unknown, index: number, seen: Set<string>): FormEmbedConfig {
  if (!rawEntry || typeof rawEntry !== "object") {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS[${index}] must be an object`);
  }

  const entry = rawEntry as RawFormEmbedConfig;
  const embedKey = stringValue(entry.embedKey ?? entry.key);
  if (!embedKey || !embedKeyPattern.test(embedKey)) {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS[${index}].embedKey must be 3-64 URL-safe characters`);
  }
  if (seen.has(embedKey)) {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS contains duplicate embedKey: ${embedKey}`);
  }
  seen.add(embedKey);

  const repoFullName = stringValue(entry.repoFullName);
  if (!repoFullName || !repoFullNamePattern.test(repoFullName)) {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS[${index}].repoFullName must be owner/repo`);
  }

  if (!Array.isArray(entry.allowedOrigins) || entry.allowedOrigins.length === 0) {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS[${index}].allowedOrigins must be a non-empty array`);
  }

  const allowedOrigins = entry.allowedOrigins.map((origin, originIndex) => normalizeAllowedOrigin(origin, index, originIndex));
  const minSubmitMs = normalizeMinSubmitMs(entry.minSubmitMs, index);

  return {
    embedKey,
    repoFullName,
    allowedOrigins,
    displayName: stringValue(entry.displayName),
    requireEmail: entry.requireEmail === true,
    minSubmitMs
  };
}

function normalizeAllowedOrigin(origin: unknown, configIndex: number, originIndex: number): string {
  const value = stringValue(origin);
  if (!value) {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS[${configIndex}].allowedOrigins[${originIndex}] must be a non-empty string`);
  }

  if (value === "*") {
    return value;
  }

  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS[${configIndex}].allowedOrigins[${originIndex}] must be a valid origin`);
  }
}

function normalizeMinSubmitMs(value: unknown, index: number): number {
  if (value === undefined) {
    return DEFAULT_MIN_SUBMIT_MS;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_MIN_SUBMIT_MS) {
    throw new ConfigError(`MOSAIC_FORM_EMBEDS[${index}].minSubmitMs must be an integer from 0 to ${MAX_MIN_SUBMIT_MS}`);
  }

  return parsed;
}

function normalizedOriginValue(origin: string): string | undefined {
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
