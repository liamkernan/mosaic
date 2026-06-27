export interface PromptImplementationPlan {
  requiredFiles: Array<{ path: string; reason: string }>;
  acceptanceCriteria: string[];
  implementationChecklist: string[];
  verificationChecklist: string[];
  verificationCommands: string[];
}

function appendBulletItems(output: string, items: string[]): string {
  for (let index = 0; index < items.length; index += 1) {
    output += `${index === 0 ? "" : "\n"}- ${items[index]}`;
  }

  return output;
}

function appendRequiredFiles(output: string, files: PromptImplementationPlan["requiredFiles"]): string {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    output += `${index === 0 ? "" : "\n"}- ${file.path}: ${file.reason}`;
  }

  return output;
}

export function formatImplementationPlanSection(plan?: PromptImplementationPlan): string {
  if (!plan) {
    return "";
  }

  let section = "\nIMPLEMENTATION PLAN:\nRequired files:\n";
  section = appendRequiredFiles(section, plan.requiredFiles);
  section += "\n\nAcceptance criteria:\n";
  section = appendBulletItems(section, plan.acceptanceCriteria);
  section += "\n\nCompletion checklist:\n";
  section = appendBulletItems(section, plan.implementationChecklist);
  section += "\n\nVerification checklist:\n";
  section = appendBulletItems(section, plan.verificationChecklist);
  section += "\n\nVerification commands:\n";
  section = appendBulletItems(section, plan.verificationCommands);

  return `${section}\n`;
}
