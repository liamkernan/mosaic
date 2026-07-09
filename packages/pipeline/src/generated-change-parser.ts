import { LLMError } from "@mosaic/core";

interface GeneratedChangeResponse {
  filePath: string;
  modifiedContent?: string;
  search?: string;
  replace?: string;
  explanation: string;
}

function decodeXmlText(value: string): string {
  if (!value.includes("&")) {
    return value;
  }

  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripBoundaryNewlines(value: string): string {
  const start = value.charCodeAt(0) === 10 ? 1 : 0;
  const end = value.charCodeAt(value.length - 1) === 10 ? value.length - 1 : value.length;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

const fullFileChangePattern = /<change>\s*<filePath>([\s\S]*?)<\/filePath>\s*<modifiedContent><!\[CDATA\[([\s\S]*?)\]\]><\/modifiedContent>\s*<explanation>([\s\S]*?)<\/explanation>\s*<\/change>/gi;
const editChangePattern = /<edit>\s*<filePath>([\s\S]*?)<\/filePath>\s*<search><!\[CDATA\[([\s\S]*?)\]\]><\/search>\s*<replace><!\[CDATA\[([\s\S]*?)\]\]><\/replace>\s*<explanation>([\s\S]*?)<\/explanation>\s*<\/edit>/gi;
const taggedChangeBlockPattern = /<(change|edit)>[\s\S]*?<\/\1>/gi;

function parseTaggedChanges(response: string): GeneratedChangeResponse[] {
  if (!/<(?:change|edit)\b/i.test(response)) {
    return [];
  }

  const changesMatch = response.match(/<changes>([\s\S]*?)<\/changes>/i);
  const source = changesMatch?.[1] ?? response;
  const changes: GeneratedChangeResponse[] = [];

  taggedChangeBlockPattern.lastIndex = 0;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = taggedChangeBlockPattern.exec(source)) !== null) {
    const block = blockMatch[0];
    if (blockMatch[1].toLowerCase() === "change") {
      fullFileChangePattern.lastIndex = 0;
      const match = fullFileChangePattern.exec(block);
      if (match) {
        changes.push({
          filePath: decodeXmlText(match[1].trim()),
          modifiedContent: stripBoundaryNewlines(match[2]),
          explanation: decodeXmlText(match[3].trim())
        });
      }
      continue;
    }

    editChangePattern.lastIndex = 0;
    const match = editChangePattern.exec(block);
    if (match) {
      changes.push({
        filePath: decodeXmlText(match[1].trim()),
        search: stripBoundaryNewlines(match[2]),
        replace: stripBoundaryNewlines(match[3]),
        explanation: decodeXmlText(match[4].trim())
      });
    }
  }

  return changes;
}

function isGeneratedChangeResponse(value: unknown): value is GeneratedChangeResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const item = value as Record<string, unknown>;
  return typeof item.filePath === "string" &&
    typeof item.explanation === "string" &&
    (typeof item.modifiedContent === "string" || (typeof item.search === "string" && typeof item.replace === "string"));
}

function parseJsonChanges(response: string): GeneratedChangeResponse[] {
  const parsed = JSON.parse(extractJsonArrayCandidate(response)) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isGeneratedChangeResponse)) {
    throw new LLMError("Code generation returned invalid structured output");
  }

  return parsed.map((change) => ({
    filePath: change.filePath,
    modifiedContent: change.modifiedContent,
    search: change.search,
    replace: change.replace,
    explanation: change.explanation
  }));
}

function extractJsonArrayCandidate(response: string): string {
  const trimmed = response.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith("[") && fenced.endsWith("]")) {
      return fenced;
    }
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }

  return trimmed;
}

function startsWithJsonArray(response: string): boolean {
  for (let index = 0; index < response.length; index += 1) {
    const charCode = response.charCodeAt(index);
    if (charCode === 91) {
      return true;
    }
    if (charCode !== 9 && charCode !== 10 && charCode !== 13 && charCode !== 32) {
      return false;
    }
  }

  return false;
}

function isExplicitEmptyChangesPayload(response: string): boolean {
  return /^<changes>\s*<\/changes>$/i.test(response.trim());
}

export function parseGeneratedChanges(response: string): GeneratedChangeResponse[] {
  if (startsWithJsonArray(response)) {
    try {
      return parseJsonChanges(response);
    } catch (error) {
      throw new LLMError("Code generation returned invalid structured output", { cause: error as Error });
    }
  }

  const taggedChanges = parseTaggedChanges(response);
  if (taggedChanges.length > 0 || isExplicitEmptyChangesPayload(response)) {
    return taggedChanges;
  }

  try {
    return parseJsonChanges(response);
  } catch (error) {
    throw new LLMError("Code generation returned invalid structured output", { cause: error as Error });
  }
}
