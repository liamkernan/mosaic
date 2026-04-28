import { LLMError } from "@mosaic/core";

interface GeneratedChangeResponse {
  filePath: string;
  modifiedContent: string;
  explanation: string;
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
  try {
    return JSON.parse(extractJsonArrayCandidate(response)) as GeneratedChangeResponse[];
  } catch (error) {
    throw new LLMError("Code generation returned invalid JSON", { cause: error as Error });
  }
}
