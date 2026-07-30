import { Buffer } from "node:buffer";

export function allocateFairContentBudgets(contentSizes: number[], maxTotalSize: number): number[] {
  const sizes = contentSizes.map((size) => Math.max(0, Math.floor(size)));
  const totalBudget = Math.max(0, Math.floor(maxTotalSize));
  const totalSize = sizes.reduce((sum, size) => sum + size, 0);
  if (totalSize <= totalBudget) {
    return sizes;
  }

  const budgets = sizes.map(() => 0);
  let remainingBudget = totalBudget;
  let pendingIndexes = sizes.map((_, index) => index);

  while (pendingIndexes.length > 0) {
    const equalShare = Math.floor(remainingBudget / pendingIndexes.length);
    const fullyFundedIndexes = pendingIndexes.filter((index) => sizes[index] <= equalShare);

    if (fullyFundedIndexes.length === 0) {
      const remainder = remainingBudget - equalShare * pendingIndexes.length;
      pendingIndexes.forEach((index, rank) => {
        budgets[index] = equalShare + (rank < remainder ? 1 : 0);
      });
      break;
    }

    const fullyFundedSet = new Set(fullyFundedIndexes);
    for (const index of fullyFundedIndexes) {
      budgets[index] = sizes[index];
      remainingBudget -= sizes[index];
    }
    pendingIndexes = pendingIndexes.filter((index) => !fullyFundedSet.has(index));
  }

  return budgets;
}

export function truncateUtf8ToBytes(content: string, maxBytes: number): string {
  const byteBudget = Math.max(0, Math.floor(maxBytes));
  const encoded = Buffer.from(content);
  if (encoded.length <= byteBudget) {
    return content;
  }

  let safeEnd = byteBudget;
  while (safeEnd > 0 && (encoded[safeEnd] & 0xc0) === 0x80) {
    safeEnd -= 1;
  }

  return encoded.subarray(0, safeEnd).toString("utf8");
}

export function truncateToCharacters(content: string, maxCharacters: number): string {
  const characterBudget = Math.max(0, Math.floor(maxCharacters));
  if (content.length <= characterBudget) {
    return content;
  }

  let truncated = content.slice(0, characterBudget);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }

  return truncated;
}
