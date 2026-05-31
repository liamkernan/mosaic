import type { GeneratedChange } from "@mosaic/core";

export function mergeGeneratedChanges(baseChanges: GeneratedChange[], repairChanges: GeneratedChange[]): GeneratedChange[] {
  const merged = new Map(baseChanges.map((change) => [change.filePath, change]));

  for (const change of repairChanges) {
    merged.set(change.filePath, change);
  }

  return [...merged.values()];
}
