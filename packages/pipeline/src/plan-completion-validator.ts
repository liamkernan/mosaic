import type { GeneratedChange } from "@mosaic/core";

import type { ImplementationPlan } from "./implementation-planner.js";

const behavioralKeywords = /\b(?:sort|order|ordering|rank|ranking|filter|tie-?breaker|fallback|dedupe|idempotent|permission|validation|api|endpoint|status|state)\b/i;
const testPathPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__|reported)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const orderedClausePattern = /`([^`]*(?:ASC|DESC|ORDER BY)[^`]*)`/gi;
const idempotencyPlanPattern = /\b(?:dedupe|duplicate|idempotent|idempotency|retry|same source|external[_\s-]?ref(?:erence)?)\b/i;

function planText(plan: ImplementationPlan, sourceText = ""): string {
  return [
    sourceText,
    ...plan.acceptanceCriteria,
    ...plan.implementationChecklist,
    ...plan.verificationChecklist
  ].join("\n");
}

function changedTestFiles(changes: GeneratedChange[]): GeneratedChange[] {
  return changes.filter((change) => testPathPattern.test(change.filePath));
}

function extractPythonListFunctionFields(content: string): Map<string, Set<string>> {
  const fieldsByFunction = new Map<string, Set<string>>();
  const functionPattern = /(?:^|\n)def\s+(list_[a-zA-Z0-9_]*)\s*\([^]*?(?=\ndef\s+|\nclass\s+|$)/g;
  let functionMatch: RegExpExecArray | null;

  while ((functionMatch = functionPattern.exec(content)) !== null) {
    const functionName = functionMatch[1];
    const block = functionMatch[0];
    const selectMatch = block.match(/\bSELECT\b([^]*?)\bFROM\b/i);
    if (!selectMatch) {
      continue;
    }

    const fields = new Set<string>();
    for (const fieldMatch of selectMatch[1].matchAll(/\b[a-z][a-z0-9_]*\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+AS\s+([a-zA-Z_][a-zA-Z0-9_]*))?/gi)) {
      fields.add((fieldMatch[2] ?? fieldMatch[1]).toLowerCase());
    }

    if (fields.size > 0) {
      fieldsByFunction.set(functionName, fields);
    }
  }

  return fieldsByFunction;
}

function generatedTestListFieldErrors(changes: GeneratedChange[]): string[] {
  const fieldsByFunction = new Map<string, Set<string>>();
  for (const change of changes.filter((item) => !testPathPattern.test(item.filePath))) {
    for (const [functionName, fields] of extractPythonListFunctionFields(change.modifiedContent)) {
      fieldsByFunction.set(functionName, fields);
    }
  }

  if (fieldsByFunction.size === 0) {
    return [];
  }

  const errors: string[] = [];
  for (const testChange of changedTestFiles(changes)) {
    for (const [functionName, availableFields] of fieldsByFunction) {
      const assignmentPattern = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\s*=\\s*${functionName}\\s*\\(`, "g");
      let assignmentMatch: RegExpExecArray | null;

      while ((assignmentMatch = assignmentPattern.exec(testChange.modifiedContent)) !== null) {
        const variableName = assignmentMatch[1];
        const fieldPattern = new RegExp(`\\b${variableName}\\s*\\[\\s*\\d+\\s*\\]\\s*\\[\\s*["']([^"']+)["']\\s*\\]`, "g");
        let fieldMatch: RegExpExecArray | null;

        while ((fieldMatch = fieldPattern.exec(testChange.modifiedContent)) !== null) {
          const fieldName = fieldMatch[1].toLowerCase();
          if (!availableFields.has(fieldName)) {
            errors.push(`Generated test asserts field "${fieldName}" on ${functionName} result, but no implementation change exposes that field on the list response`);
          }
        }
      }
    }
  }

  return errors;
}

function planRequiresBehavioralTests(plan: ImplementationPlan, sourceText = ""): boolean {
  const text = planText(plan, sourceText);
  const testChangePattern = /\b(?:add|update|create|write|extend|modify)\b.{0,80}\b(?:test|tests|spec|specs|coverage|unittest|pytest|jest|vitest)\b/i;
  const checklistRequestsTestChanges = [
    ...plan.implementationChecklist,
    ...plan.verificationChecklist
  ].some((item) => testChangePattern.test(item));
  const requiredTestFileChange = plan.requiredFiles.some((file) =>
    (testPathPattern.test(file.path) || /\b(?:test|tests|spec|coverage)\b/i.test(file.reason)) &&
    testChangePattern.test(file.reason)
  );

  return behavioralKeywords.test(text) && (checklistRequestsTestChanges || requiredTestFileChange);
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

function extractOrderedClauses(plan: ImplementationPlan, sourceText = ""): string[][] {
  const clauses: string[][] = [];
  const text = planText(plan, sourceText);
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

function planRequiresIdempotencyUpdate(plan: ImplementationPlan, sourceText = ""): boolean {
  const text = planText(plan, sourceText);
  return idempotencyPlanPattern.test(text) &&
    /\b(?:update|existing|same|duplicate|retry|idempotent|dedupe)\b/i.test(text);
}

function contentHasIdempotencyUpdatePath(content: string): boolean {
  const blocks = content.split(/\n(?=(?:async\s+)?(?:def|function)\s+|(?:export\s+)?(?:async\s+)?function\s+|class\s+)/i);

  return blocks.some((block) => {
    const compact = block.toLowerCase().replace(/\s+/g, " ");
    const identifiesRequest = /\b(?:external_ref|externalref|external reference|idempotency|dedupe|duplicate|source)\b/.test(compact);
    const createsRequest = /(?:\b|_)(?:insert|create|add|save)(?:\b|_)/.test(compact);
    const findsExisting = /(?:\b|_)(?:select|where|find|lookup|get_or_create|existing|on conflict|upsert|merge)(?:\b|_)/.test(compact);
    const updatesExisting = /(?:\b|_)(?:update|on conflict|upsert|merge|set)(?:\b|_)/.test(compact);
    return identifiesRequest && createsRequest && findsExisting && updatesExisting;
  });
}

export function validatePlanCompletion(changes: GeneratedChange[], plan: ImplementationPlan | undefined, sourceText = ""): string[] {
  if (!plan) {
    return [];
  }

  const errors: string[] = [];
  errors.push(...generatedTestListFieldErrors(changes));

  if (planRequiresBehavioralTests(plan, sourceText) && changedTestFiles(changes).length === 0) {
    errors.push("Implementation plan requires behavioral test coverage, but the generated change does not modify any test/spec file");
  }

  const implementationChanges = changes.filter((change) => !testPathPattern.test(change.filePath));
  if (planRequiresIdempotencyUpdate(plan, sourceText) && !implementationChanges.some((change) => contentHasIdempotencyUpdatePath(change.modifiedContent))) {
    errors.push("Acceptance criteria require an idempotent duplicate/retry update path, but no implementation change appears to look up and update an existing record by the idempotency key");
  }

  for (const terms of extractOrderedClauses(plan, sourceText)) {
    const matched = implementationChanges.some((change) => contentContainsTermsInOrder(change.modifiedContent, terms));
    if (!matched) {
      errors.push(`Acceptance criteria require ordered clause ${terms.join(", ")}, but no implementation change contains those terms in that order`);
    }
  }

  return errors;
}
