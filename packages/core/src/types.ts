// === FEEDBACK TYPES ===

export type FeedbackSource = "web_form" | "email" | "github_issue" | "github_comment" | "discord" | "api";

export type FeedbackCategory = "bug_report" | "feature_request" | "copy_change" | "ui_tweak" | "question" | "other";

export type ComplexityLevel = "trivial" | "simple" | "moderate" | "complex";

export interface FeedbackItem {
  id: string;
  source: FeedbackSource;
  rawContent: string;
  senderIdentifier: string;
  repoFullName: string;
  receivedAt: Date;
  metadata: Record<string, unknown>;
}

export interface ClassifiedFeedback extends FeedbackItem {
  category: FeedbackCategory;
  complexity: ComplexityLevel;
  summary: string;
  relevantFiles: string[];
  confidence: number;
}

// === REPO TYPES ===

export interface RepoContext {
  fullName: string;
  defaultBranch: string;
  localPath: string;
  fileTree: FileNode[];
  installationId: number;
}

export interface FileNode {
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  language?: string;
  sizeBytes?: number;
}

export interface RelevantFile {
  path: string;
  content: string;
  reason: string;
}

// === CODE GENERATION TYPES ===

export interface GeneratedChange {
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  explanation: string;
}

export interface PRPayload {
  repoFullName: string;
  branchName: string;
  title: string;
  body: string;
  changes: GeneratedChange[];
  feedbackItem: ClassifiedFeedback;
}

// === CONFIG TYPES ===

export type LLMKeyMode = "platform" | "byok";

export interface RepoConfig {
  repoFullName: string;
  intakeSources: FeedbackSource[];
  allowedCategories: FeedbackCategory[];
  maxComplexity: ComplexityLevel;
  llmKeyMode: LLMKeyMode;
  llmApiKey?: string;
  reviewers?: string[];
  branchPrefix: string;
}
