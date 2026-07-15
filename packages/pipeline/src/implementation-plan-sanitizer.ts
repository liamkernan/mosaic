const genericProtectedTestReference = "immutable verification tests";
const testPathPattern = /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

export interface ModelVisiblePlanPathPolicy {
  protectedPaths: readonly string[];
  protectedPathPrefixes?: readonly string[];
  generatedTestPathPrefixes: readonly string[];
}

export interface ModelVisibleImplementationPlan {
  requiredFiles: Array<{ path: string; reason: string }>;
  acceptanceCriteria: string[];
  implementationChecklist: string[];
  verificationChecklist: string[];
  verificationCommands: string[];
}

function pathSegments(value: string): string[] {
  return value
    .trim()
    .replace(/^\.?(?:[\\/])/, "")
    .split(/[\\/.]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function canonicalPath(value: string): string {
  return pathSegments(value).join("/");
}

function canonicalPathMatchesPrefix(path: string, prefix: string): boolean {
  const normalizedPath = canonicalPath(path);
  const normalizedPrefix = canonicalPath(prefix);
  return normalizedPrefix.length > 0 &&
    (normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`));
}

function canonicalPathMatchesExact(path: string, expectedPath: string): boolean {
  return canonicalPath(path) === canonicalPath(expectedPath);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathReferenceRegexes(path: string, prefix: boolean): RegExp[] {
  const segments = pathSegments(path);
  if (segments.length === 0) {
    return [];
  }

  const separator = String.raw`[\\/.]+`;
  const token = String.raw`[A-Za-z0-9_@%+~:#?=&$()\[\]-]+`;
  const patterns = [segments];
  const extension = segments.at(-1);
  if (!prefix && extension && /^(?:py|[cm]?[jt]sx?)$/i.test(extension) && segments.length > 1) {
    patterns.push(segments.slice(0, -1));
  }

  return patterns.map((patternSegments) => {
    const base = patternSegments.map(escapeRegex).join(separator);
    const tail = prefix ? `(?:${separator}${token})*[\\/]?` : "";
    return new RegExp(`(?<![A-Za-z0-9_])${base}${tail}(?![A-Za-z0-9_-])`, "gi");
  });
}

function protectedReferenceRegexes(policy: ModelVisiblePlanPathPolicy): RegExp[] {
  return [
    ...policy.protectedPaths.flatMap((path) => pathReferenceRegexes(path, false)),
    ...(policy.protectedPathPrefixes ?? []).flatMap((path) => pathReferenceRegexes(path, true))
  ];
}

function allowedGeneratedPath(path: string, policy: ModelVisiblePlanPathPolicy): boolean {
  return policy.generatedTestPathPrefixes.some((prefix) => canonicalPathMatchesPrefix(path, prefix));
}

function testPath(path: string): boolean {
  return testPathPattern.test(path.replaceAll("\\", "/"));
}

export function isProtectedModelVisiblePath(
  path: string,
  policy: ModelVisiblePlanPathPolicy
): boolean {
  return policy.protectedPaths.some((protectedPath) => canonicalPathMatchesExact(path, protectedPath)) ||
    (policy.protectedPathPrefixes ?? []).some((prefix) => canonicalPathMatchesPrefix(path, prefix));
}

export function containsProtectedModelVisiblePath(
  text: string,
  policy: ModelVisiblePlanPathPolicy
): boolean {
  return protectedReferenceRegexes(policy).some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function collapseGenericReferences(text: string): string {
  return text.replace(
    /immutable verification tests(?:\s*(?:,|and|or)\s*immutable verification tests)+/gi,
    genericProtectedTestReference
  );
}

export function sanitizeModelVisiblePlanText(
  text: string,
  policy: ModelVisiblePlanPathPolicy
): string {
  let sanitized = text;
  for (const pattern of protectedReferenceRegexes(policy)) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, genericProtectedTestReference);
  }
  return collapseGenericReferences(sanitized);
}

export function sanitizeModelVisiblePaths(
  paths: readonly string[],
  policy: ModelVisiblePlanPathPolicy
): string[] {
  return paths.filter((path) =>
    !isProtectedModelVisiblePath(path, policy) &&
    !containsProtectedModelVisiblePath(path, policy)
  );
}

export function sanitizeModelVisibleContext<T>(
  value: T,
  policy: ModelVisiblePlanPathPolicy
): T {
  return sanitizeUnknown(value, policy, []) as T;
}

export function sanitizeModelVisibleFileEntries<T extends { path: string }>(
  files: readonly T[],
  policy: ModelVisiblePlanPathPolicy
): T[] {
  return files
    .filter((file) => sanitizeModelVisiblePaths([file.path], policy).length === 1)
    .map((file) => sanitizeModelVisibleContext(file, policy));
}

function extensionForGeneratedTest(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extensionIndex = fileName.lastIndexOf(".");
  return extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : ".py";
}

function genericGeneratedTestName(path: string): string {
  const extension = extensionForGeneratedTest(path);
  if (extension === ".py") {
    return "test_generated_regression.py";
  }
  if (/^\.(?:[cm]?[jt]sx?)$/.test(extension)) {
    return `generated-regression.test${extension}`;
  }
  return `generated-regression${extension}`;
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function generatedPrefix(policy: ModelVisiblePlanPathPolicy): string | undefined {
  const prefix = policy.generatedTestPathPrefixes[0]?.replaceAll("\\", "/");
  return prefix ? `${prefix.replace(/\/+$/, "")}/` : undefined;
}

function uniqueGeneratedPath(candidate: string, occupiedPaths: Set<string>): string {
  if (!occupiedPaths.has(canonicalPath(candidate))) {
    occupiedPaths.add(canonicalPath(candidate));
    return candidate;
  }

  const extensionIndex = candidate.lastIndexOf(".");
  const stem = extensionIndex >= 0 ? candidate.slice(0, extensionIndex) : candidate;
  const extension = extensionIndex >= 0 ? candidate.slice(extensionIndex) : "";
  for (let suffix = 2; ; suffix += 1) {
    const testModuleMatch = stem.match(/^(.*)(\.test)$/);
    const suffixed = testModuleMatch
      ? `${testModuleMatch[1]}-${suffix}${testModuleMatch[2]}${extension}`
      : `${stem}${extension === ".py" ? "_" : "-"}${suffix}${extension}`;
    if (!occupiedPaths.has(canonicalPath(suffixed))) {
      occupiedPaths.add(canonicalPath(suffixed));
      return suffixed;
    }
  }
}

interface PathRelocation {
  sourcePath: string;
  replacementPath: string;
}

function modulePath(path: string): string {
  return path.replace(/\.[^./]+$/, "").replaceAll("/", ".");
}

function applyRelocations(text: string, relocations: PathRelocation[]): string {
  let relocated = text;
  for (const relocation of relocations) {
    for (const pattern of pathReferenceRegexes(relocation.sourcePath, false)) {
      pattern.lastIndex = 0;
      relocated = relocated.replace(pattern, (match) => {
        const sourceExtension = extensionForGeneratedTest(relocation.sourcePath);
        const dottedModule = !/[\\/]/.test(match) &&
          !match.toLowerCase().endsWith(sourceExtension.toLowerCase());
        return dottedModule ? modulePath(relocation.replacementPath) : relocation.replacementPath;
      });
    }
  }
  return relocated;
}

function sanitizeText(
  text: string,
  policy: ModelVisiblePlanPathPolicy,
  relocations: PathRelocation[]
): string {
  return sanitizeModelVisiblePlanText(applyRelocations(text, relocations), policy);
}

function sanitizeUnknown(
  value: unknown,
  policy: ModelVisiblePlanPathPolicy,
  relocations: PathRelocation[]
): unknown {
  if (typeof value === "string") {
    return sanitizeText(value, policy, relocations);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, policy, relocations));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      sanitizeUnknown(item, policy, relocations)
    ]));
  }
  return value;
}

export function sanitizeImplementationPlanForModel<T extends ModelVisibleImplementationPlan>(
  plan: T,
  policy: ModelVisiblePlanPathPolicy
): T {
  const targetPrefix = generatedPrefix(policy);
  const occupiedPaths = new Set(plan.requiredFiles
    .filter((file) => !isProtectedModelVisiblePath(file.path, policy) &&
      (!testPath(file.path) || allowedGeneratedPath(file.path, policy)))
    .map((file) => canonicalPath(file.path)));
  const relocations: PathRelocation[] = [];
  const droppedUnapprovedTestPaths: string[] = [];
  const requiredFiles: Array<{ path: string; reason: string }> = [];

  for (const file of plan.requiredFiles) {
    const explicitlyProtected = isProtectedModelVisiblePath(file.path, policy);
    const unapprovedTestPath = testPath(file.path) && !allowedGeneratedPath(file.path, policy);
    if (!explicitlyProtected && !unapprovedTestPath) {
      requiredFiles.push({
        path: file.path,
        reason: file.reason
      });
      continue;
    }
    if (!targetPrefix) {
      if (!explicitlyProtected) {
        droppedUnapprovedTestPaths.push(file.path);
      }
      continue;
    }

    const generatedName = explicitlyProtected
      ? genericGeneratedTestName(file.path)
      : basename(file.path);
    const replacementPath = uniqueGeneratedPath(`${targetPrefix}${generatedName}`, occupiedPaths);
    if (!explicitlyProtected) {
      relocations.push({ sourcePath: file.path, replacementPath });
    }
    requiredFiles.push({
      path: replacementPath,
      reason: explicitlyProtected
        ? "Add independent generated regression coverage; immutable verification tests remain separate"
        : file.reason
    });
  }

  const effectivePolicy = droppedUnapprovedTestPaths.length > 0
    ? {
        ...policy,
        protectedPaths: [...policy.protectedPaths, ...droppedUnapprovedTestPaths]
      }
    : policy;
  const sanitized = sanitizeUnknown(plan, effectivePolicy, relocations) as T;
  const removedProtectedCommand = plan.verificationCommands.some((command) =>
    containsProtectedModelVisiblePath(command, effectivePolicy)
  );
  const verificationChecklist = plan.verificationChecklist
    .map((item) => sanitizeText(item, effectivePolicy, relocations));
  if (removedProtectedCommand &&
      !verificationChecklist.some((item) => item.toLowerCase().includes(genericProtectedTestReference))) {
    verificationChecklist.push(
      "Verify behavior with immutable verification tests outside model-visible implementation and repair."
    );
  }
  return {
    ...sanitized,
    requiredFiles: requiredFiles.map((file) => ({
      ...file,
      reason: sanitizeText(file.reason, effectivePolicy, relocations)
    })),
    acceptanceCriteria: plan.acceptanceCriteria.map((item) => sanitizeText(item, effectivePolicy, relocations)),
    implementationChecklist: plan.implementationChecklist.map((item) => sanitizeText(item, effectivePolicy, relocations)),
    verificationChecklist,
    verificationCommands: plan.verificationCommands
      .filter((command) => !containsProtectedModelVisiblePath(command, effectivePolicy))
      .map((command) => sanitizeText(command, effectivePolicy, relocations))
  };
}
