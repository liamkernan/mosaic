import type { GeneratedChange } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";

const behavioralKeywords = /\b(?:sort|order|ordering|rank|ranking|filter|tie-?breaker|fallback|dedupe|idempotent|permission|validation|api|endpoint|status|state)\b/i;
const testPathPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const orderedClausePattern = /`([^`]*(?:ASC|DESC|ORDER BY)[^`]*)`/gi;

function planText(plan: ImplementationPlan): string {
  return [
    ...plan.acceptanceCriteria,
    ...plan.implementationChecklist,
    ...plan.verificationChecklist
  ].join("\n");
}

function changedTestFiles(changes: GeneratedChange[]): GeneratedChange[] {
  return changes.filter((change) => testPathPattern.test(change.filePath));
}

function planRequiresBehavioralTests(plan: ImplementationPlan): boolean {
  const text = planText(plan);
  const checklistRequestsTests = plan.verificationChecklist.some((item) => /\b(?:test|tests|spec|unittest|vitest|pytest|jest)\b/i.test(item));
  const requiredTestFile = plan.requiredFiles.some((file) => testPathPattern.test(file.path) || /\b(?:test|tests|spec|coverage)\b/i.test(file.reason));

  return behavioralKeywords.test(text) && (checklistRequestsTests || requiredTestFile);
}

function orderedClauseTerms(clause: string): string[] {
  return clause
    .replace(/\bORDER\s+BY\b/gi, "")
    .replace(/\bthen\b/gi, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/([a-zA-Z_][a-zA-Z0-9_.]*)\s+(ASC|DESC)\b/i);
      if (!match) {
        return "";
      }

      return `${match[1].split(".").pop()} ${match[2].toUpperCase()}`;
    })
    .filter(Boolean);
}

function extractOrderedClauses(plan: ImplementationPlan): string[][] {
  const clauses: string[][] = [];
  const text = planText(plan);
  let match: RegExpExecArray | null;

  while ((match = orderedClausePattern.exec(text)) !== null) {
    const terms = orderedClauseTerms(match[1]);
    if (terms.length >= 2) {
      clauses.push(terms);
    }
  }

  for (const line of text.split("\n")) {
    const backtickedTerms = [...line.matchAll(/`([^`]+)`/g)]
      .flatMap((termMatch) => orderedClauseTerms(termMatch[1]));
    if (backtickedTerms.length >= 2) {
      clauses.push(backtickedTerms);
    }
  }

  return clauses;
}

function contentContainsTermsInOrder(content: string, terms: string[]): boolean {
  const compact = content.toLowerCase().replace(/\s+/g, " ");
  let cursor = 0;

  for (const term of terms) {
    const [field, direction] = term.toLowerCase().split(" ");
    const fieldIndex = compact.indexOf(field, cursor);
    if (fieldIndex < 0) {
      return false;
    }

    const directionIndex = compact.indexOf(direction, fieldIndex + field.length);
    if (directionIndex < 0 || directionIndex - fieldIndex > 80) {
      return false;
    }

    cursor = directionIndex + direction.length;
  }

  return true;
}

export function validatePlanCompletion(changes: GeneratedChange[], plan: ImplementationPlan | undefined): string[] {
  if (!plan) {
    return [];
  }

  const errors: string[] = [];

  if (planRequiresBehavioralTests(plan) && changedTestFiles(changes).length === 0) {
    errors.push("Implementation plan requires behavioral test coverage, but the generated change does not modify any test/spec file");
  }

  const implementationChanges = changes.filter((change) => !testPathPattern.test(change.filePath));
  for (const terms of extractOrderedClauses(plan)) {
    const matched = implementationChanges.some((change) => contentContainsTermsInOrder(change.modifiedContent, terms));
    if (!matched) {
      errors.push(`Acceptance criteria require ordered clause ${terms.join(", ")}, but no implementation change contains those terms in that order`);
    }
  }

  return errors;
}
