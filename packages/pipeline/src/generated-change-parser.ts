import { LLMError } from "@mosaic/core";

interface GeneratedChangeResponse {
  filePath: string;
  modifiedContent: string;
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
  const changesMatch = response.match(/<changes>([\s\S]*?)<\/changes>/i);
  const source = changesMatch?.[1] ?? response;
  const matches = Array.from(
    source.matchAll(
      /<change>\s*<filePath>([\s\S]*?)<\/filePath>\s*<modifiedContent><!\[CDATA\[([\s\S]*?)\]\]><\/modifiedContent>\s*<explanation>([\s\S]*?)<\/explanation>\s*<\/change>/gi
    )
  );

  return matches.map((match) => ({
    filePath: decodeXmlText(match[1].trim()),
    modifiedContent: match[2].replace(/^\n/, "").replace(/\n$/, ""),
    explanation: decodeXmlText(match[3].trim())
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
  const taggedChanges = parseTaggedChanges(response);
  if (taggedChanges.length > 0) {
    return taggedChanges;
  }

  try {
    return JSON.parse(extractJsonArrayCandidate(response)) as GeneratedChangeResponse[];
  } catch (error) {
    throw new LLMError("Code generation returned invalid structured output", { cause: error as Error });
  }
}
