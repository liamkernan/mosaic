import { LLMError } from "@mosaic/core";

interface GeneratedChangeResponse {
  filePath: string;
  modifiedContent?: string;
  search?: string;
  replace?: string;
  explanation: string;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseTaggedChanges(response: string): GeneratedChangeResponse[] {
  if (!/<(?:change|edit)\b/i.test(response)) {
    return [];
  }

  const changesMatch = response.match(/<changes>([\s\S]*?)<\/changes>/i);
  const source = changesMatch?.[1] ?? response;
  const fullFileMatches = Array.from(
    source.matchAll(
      /<change>\s*<filePath>([\s\S]*?)<\/filePath>\s*<modifiedContent><!\[CDATA\[([\s\S]*?)\]\]><\/modifiedContent>\s*<explanation>([\s\S]*?)<\/explanation>\s*<\/change>/gi
    )
  );
  const editMatches = Array.from(
    source.matchAll(
      /<edit>\s*<filePath>([\s\S]*?)<\/filePath>\s*<search><!\[CDATA\[([\s\S]*?)\]\]><\/search>\s*<replace><!\[CDATA\[([\s\S]*?)\]\]><\/replace>\s*<explanation>([\s\S]*?)<\/explanation>\s*<\/edit>/gi
    )
  );

  return [
    ...fullFileMatches.map((match) => ({
      filePath: decodeXmlText(match[1].trim()),
      modifiedContent: match[2].replace(/^\n/, "").replace(/\n$/, ""),
      explanation: decodeXmlText(match[3].trim())
    })),
    ...editMatches.map((match) => ({
      filePath: decodeXmlText(match[1].trim()),
      search: match[2].replace(/^\n/, "").replace(/\n$/, ""),
      replace: match[3].replace(/^\n/, "").replace(/\n$/, ""),
      explanation: decodeXmlText(match[4].trim())
    }))
  ];
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

export function parseGeneratedChanges(response: string): GeneratedChangeResponse[] {
  if (response.trimStart().startsWith("[")) {
    try {
      return parseJsonChanges(response);
    } catch (error) {
      throw new LLMError("Code generation returned invalid structured output", { cause: error as Error });
    }
  }

  const taggedChanges = parseTaggedChanges(response);
  if (taggedChanges.length > 0) {
    return taggedChanges;
  }

  try {
    return parseJsonChanges(response);
  } catch (error) {
    throw new LLMError("Code generation returned invalid structured output", { cause: error as Error });
  }
}
