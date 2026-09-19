import type {
  DevelopmentAttempt,
  CommandActivity,
  WorkflowActivity,
  WorkflowCheck,
  WorkflowEvidence,
  WorkflowRecord,
} from "./owwWorkflow.ts";

const sensitive =
  /(?:secret|token|password|credential|private[ _-]?key|session[ _-]?token|authorization(?:[ _-]?header)?|bearer(?:[ _-]?token)?|api[ _-]?key)/i;
const privateReasoning =
  /(?:chain[ -]of[ -]thought|hidden reasoning|scratchpad|(?:^|\s)(?:my reasoning|i think|i considered)(?:\s|:)|(?:system|developer|user) prompt\s*:)/i;
const hostPath = /(?:^|\s)\/(?!\/)/;

const safe = (value?: string | null) =>
  value && !sensitive.test(value) && !privateReasoning.test(value) && !hostPath.test(value)
    ? value
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240)
    : undefined;
const stripAnsi = (value: string) =>
  value
    .split(String.fromCharCode(27))
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-?]*[ -/]*[@-~]/, "")))
    .join("");
const safeExcerpt = (value?: string | null) => {
  if (!value) return undefined;
  const normalized = [...stripAnsi(value)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        character === "\t" ||
        character === "\n" ||
        character === "\r" ||
        (code >= 32 && code !== 127)
      );
    })
    .join("")
    .replace(/```/g, "'''")
    .trim()
    .slice(0, 1200);
  return normalized &&
    !sensitive.test(normalized) &&
    !privateReasoning.test(normalized) &&
    !hostPath.test(normalized)
    ? normalized
    : undefined;
};
const shortSha = (value?: string | null) =>
  value && /^[0-9a-f]{40}$/i.test(value) ? value.slice(0, 12) : undefined;
const hardLine = (value: string) => `${value}  `;
const line = (lines: string[], label: string, value?: string | null) => {
  if (value) lines.push(hardLine(`${label}: ${value}`));
};
const detailSection = (lines: string[], heading: string, value?: string) => {
  if (value) lines.push("", hardLine(heading), value);
};
const listSection = (lines: string[], heading: string, entries: Array<string | undefined>) => {
  const values = entries.filter((entry): entry is string => Boolean(entry));
  if (values.length) lines.push("", heading, "", ...values.map((entry) => `- ${entry}`));
};
const terminalSection = (lines: string[], heading: string, value?: string) => {
  if (value) lines.push("", heading, "", "```text", value, "```");
};

const keyFields = [
  "status",
  "outcome",
  "summary",
  "current_task",
  "current_task_status",
  "stopped_at",
  "candidate_sha",
  "pr_url",
  "pr_number",
  "github_check_summary",
  "merged_sha",
  "uat_status",
  "deployed_sha",
  "waiting_reason",
  "waiting_resource",
  "resource_scope",
  "lock_owner",
  "waiting_seconds",
  "required_human_action",
  "latest_safe_progress_message",
  "executor_provider",
  "executor_model",
  "executor_reasoning_effort",
  "current_activity",
  "recent_actions",
  "attempt_number",
  "attempt_limit",
  "attempt_role",
  "attempt_profile",
  "attempt_escalation",
  "development_attempts",
  "safe_files",
  "checks",
  "evidence",
  "failure_classification",
  "validation_failed_check",
  "validation_failed_kind",
  "validation_exit_code",
  "validation_failure_fingerprint",
  "validation_command",
  "validation_duration_ms",
  "validation_stdout_excerpt",
  "validation_stderr_excerpt",
  "validation_repair_count",
  "validation_repair_limit",
  "validation_targeted",
  "review_findings",
  "next_action",
];
export const workflowStatusKey = (value: WorkflowRecord) =>
  JSON.stringify(keyFields.map((field) => value[field] ?? null));

const transitionFields = [
  "status",
  "outcome",
  "current_task",
  "current_task_status",
  "stopped_at",
  "candidate_sha",
  "pr_url",
  "pr_number",
  "merged_sha",
  "deployed_sha",
  "waiting_reason",
  "waiting_resource",
  "resource_scope",
  "lock_owner",
  "required_human_action",
  "current_activity",
  "executor_provider",
  "executor_model",
  "executor_reasoning_effort",
  "attempt_number",
  "attempt_escalation",
  "failure_classification",
  "validation_failed_check",
  "validation_failure_fingerprint",
  "validation_repair_count",
  "next_action",
  "retryable_task_id",
];
const liveStatusRefreshSeconds = 60;

const liveStatusBucket = (value: WorkflowRecord) =>
  value.status === "RUNNING" &&
  value.current_task_status === "RUNNING" &&
  typeof value.stage_elapsed_seconds === "number" &&
  Number.isFinite(value.stage_elapsed_seconds)
    ? Math.floor(Math.max(0, value.stage_elapsed_seconds) / liveStatusRefreshSeconds)
    : null;

/** Summary messages refresh on transitions and once a minute while an executor is active. */
export const workflowTransitionKey = (value: WorkflowRecord) =>
  JSON.stringify([
    ...transitionFields.map((field) => value[field] ?? null),
    liveStatusBucket(value),
  ]);

export const applicationDeliverySucceeded = (value: WorkflowRecord): boolean =>
  value.work_kind === "application_change" &&
  value.outcome === "complete" &&
  Boolean(shortSha(value.candidate_sha)) &&
  Boolean(value.pr_url) &&
  Boolean(shortSha(value.merged_sha)) &&
  Boolean(shortSha(value.deployed_sha)) &&
  value.deployed_sha === value.merged_sha;

const stages: Record<string, { name: string; icon: string }> = {
  "prepare-run": { name: "Prepare", icon: "⏳" },
  plan: { name: "Planning", icon: "🧠" },
  develop: { name: "Development", icon: "🛠" },
  validate: { name: "Validation", icon: "🧪" },
  review: { name: "Review", icon: "🔍" },
  "application-change": { name: "Workflow", icon: "⏳" },
  "publish-pull-request": { name: "Publishing", icon: "📤" },
  "github-check-status": { name: "CI", icon: "🔄" },
  "merge-exact-candidate": { name: "Merge", icon: "🔀" },
  "inspect-uat": { name: "UAT Inspection", icon: "🗄" },
  "prepare-uat-backup": { name: "UAT Backup", icon: "💾" },
  "deploy-uat-exact-sha": { name: "UAT Deployment", icon: "🚢" },
  "verify-uat": { name: "UAT Verification", icon: "🩺" },
};

const taskMeta = (task?: string | null) =>
  task ? (stages[task] ?? { name: task, icon: "⏳" }) : undefined;
const displayStage = (value: WorkflowRecord) => {
  if (value.current_task !== "application-change")
    return taskMeta(value.current_task ?? value.stopped_at);
  if (value.waiting_reason?.includes("candidate approval")) return { name: "Approval", icon: "🟡" };
  if (value.waiting_reason?.includes("migration approval"))
    return { name: "Migration Approval", icon: "🗃" };
  if (value.current_activity?.includes("GitHub checks")) return stages["github-check-status"];
  return stages["application-change"];
};

const route = (value: WorkflowRecord): string | undefined => {
  const provider =
    value.executor_provider === "codex"
      ? "Codex"
      : value.executor_provider === "devin"
        ? "Devin"
        : undefined;
  const model = safe(value.executor_model);
  if (!provider || !model) return undefined;
  const effort = safe(value.executor_reasoning_effort);
  return `${provider} / ${model}${effort ? ` • ${effort} reasoning` : ""}`;
};

const safePrLink = (value?: string | null, number?: number | null): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const match = /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !match) return undefined;
    const pr = number ?? Number(match[1]);
    return Number.isSafeInteger(pr) && pr > 0 ? `[PR #${pr}](${url.href})` : undefined;
  } catch {
    return undefined;
  }
};

const safeActivities = (value: WorkflowRecord): WorkflowActivity[] => {
  const result: WorkflowActivity[] = [];
  for (const activity of value.recent_actions ?? []) {
    const message = safe(activity?.message);
    if (!message || !["current", "completed", "warning", "failed"].includes(activity.state))
      continue;
    const prior = result.findIndex((item) => item.message === message);
    if (prior >= 0) result.splice(prior, 1);
    result.push({ message, state: activity.state, entry_kind: activity.entry_kind });
  }
  return result.slice(-8);
};

const activityLine = (activity: WorkflowActivity): string => {
  if (activity.state === "failed") return `❌ ${activity.message}`;
  if (activity.state === "warning") return `⚠️ ${activity.message}`;
  if (activity.state === "current") return `▶️ ${activity.message}`;
  if (/^(?:editing|updated|updating)\b/i.test(activity.message)) return `✏️ ${activity.message}`;
  if (/escalat/i.test(activity.message)) return `⬆️ ${activity.message}`;
  if (/retry/i.test(activity.message)) return `🔁 ${activity.message}`;
  return `✅ ${activity.message}`;
};

const stateLine = (name: string, state: WorkflowCheck["state"]): string => {
  const marker =
    state === "passed"
      ? "✅"
      : state === "failed"
        ? "❌"
        : state === "running"
          ? "▶️"
          : state === "warning"
            ? "⚠️"
            : "⏳";
  return `${marker} ${name}`;
};

const checks = (value: WorkflowRecord): WorkflowCheck[] => {
  const result: WorkflowCheck[] = [];
  for (const check of value.checks ?? []) {
    const name = safe(check?.name);
    if (!name || !["passed", "failed", "pending", "running", "warning"].includes(check.state))
      continue;
    const prior = result.findIndex((item) => item.name === name);
    if (prior >= 0) result.splice(prior, 1);
    result.push({ name, state: check.state });
  }
  return result;
};

const evidence = (value: WorkflowRecord): WorkflowEvidence[] => {
  const result: WorkflowEvidence[] = [];
  for (const item of value.evidence ?? []) {
    const message = safe(item?.message);
    if (!message || !["passed", "failed", "pending", "running", "warning"].includes(item.state))
      continue;
    const prior = result.findIndex((entry) => entry.message === message);
    if (prior >= 0) result.splice(prior, 1);
    result.push({ message, state: item.state });
  }
  return result;
};

const attempts = (value: WorkflowRecord): DevelopmentAttempt[] =>
  (value.development_attempts ?? [])
    .filter(
      (attempt) =>
        Number.isInteger(attempt.attempt_number) &&
        attempt.attempt_number > 0 &&
        Boolean(safe(attempt.role)) &&
        Boolean(safe(attempt.profile)) &&
        Boolean(safe(attempt.model)),
    )
    .slice(0, 6);

const attemptLine = (attempt: DevelopmentAttempt): string => {
  const provider = attempt.provider === "codex" ? "Codex" : "Devin";
  const result =
    safe(attempt.result_classification)?.toLowerCase().replaceAll("_", " ") ?? "unknown result";
  const profile = safe(attempt.profile);
  const exit = Number.isInteger(attempt.executor_exit_code)
    ? ` (exit ${attempt.executor_exit_code})`
    : "";
  return `${attempt.attempt_number}. ${provider} / ${safe(attempt.model)}${profile ? ` (${profile})` : ""} → ${result}${exit}`;
};

const activeCommand = (value: WorkflowRecord): CommandActivity | undefined =>
  (value.command_events ?? [])
    .filter(
      (command): command is CommandActivity =>
        command.entry_kind === "command" &&
        command.command_state === "started" &&
        Boolean(safe(command.display_command)),
    )
    .at(-1);

const elapsed = (seconds?: number | null): string | undefined => {
  if (!Number.isInteger(seconds) || seconds === undefined || seconds === null || seconds < 0)
    return undefined;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
};

const terminalState = (value: WorkflowRecord): string | undefined => {
  if (value.status !== "COMPLETED") return undefined;
  if (value.outcome === "attention_required") return "ATTENTION REQUIRED";
  if (value.outcome === "engineering_failure") return "FAILED / STOPPED";
  if (value.outcome === "hard_stop") return "BLOCKED / HARD STOP";
  if (value.outcome === "rejected") return "REJECTED";
  if (value.outcome === "smoke_complete") return "SUCCESS / COMPLETE";
  if (applicationDeliverySucceeded(value)) return "SUCCESS / COMPLETE";
  return "FAILED / INCOMPLETE RELEASE EVIDENCE";
};

const visualState = (value: WorkflowRecord): string => {
  const terminal = terminalState(value);
  if (terminal) return terminal;
  if (value.current_task === "develop" && value.attempt_escalation) return "ESCALATED";
  if (value.current_task === "develop" && (value.attempt_number ?? 1) > 1) return "RETRYING";
  return value.current_task_status ?? value.status;
};

const header = (value: WorkflowRecord): string => {
  if (applicationDeliverySucceeded(value)) return "🎉 COMPLETE";
  const stage = displayStage(value) ?? { name: "Workflow", icon: "⏳" };
  const state = visualState(value);
  if (state.includes("HARD STOP")) return `🛑 ${stage.name} • HARD STOP`;
  if (state === "ATTENTION REQUIRED") return `🟠 ${stage.name} • ATTENTION REQUIRED`;
  if (state.startsWith("FAILED")) return `❌ ${stage.name} • ${state}`;
  if (state === "REJECTED") return `❌ ${stage.name} • REJECTED`;
  if (state === "ESCALATED") return `⬆️ ${stage.name} • ESCALATED`;
  if (state === "RETRYING") return `🔁 ${stage.name} • RETRYING`;
  if (stage.name === "Approval" && state === "WAITING") return "🟡 Approval Required";
  return `${stage.icon} ${stage.name} • ${state}`;
};

export function formatWorkflowProgress(value: WorkflowRecord): string {
  const lines = [header(value)];
  const secondary: string[] = [];
  const executor = route(value);
  if (executor) secondary.push(executor);
  const allAttempts = attempts(value);
  const number = value.attempt_number ?? allAttempts.at(-1)?.attempt_number;
  const limit = value.attempt_limit ?? allAttempts.at(-1)?.attempt_limit;
  if (value.current_task === "develop" && number && limit)
    secondary.push(`Attempt ${number}/${limit}`);
  const stageChecks = checks(value);
  if (value.current_task === "validate" && stageChecks.length) {
    secondary.push("Deterministic checks");
    secondary.push(
      `${stageChecks.filter((check) => check.state === "passed").length}/${stageChecks.length} complete`,
    );
  }
  const duration = elapsed(value.stage_elapsed_seconds);
  if (duration) secondary.push(duration);
  if (secondary.length) {
    lines[0] = hardLine(lines[0] ?? header(value));
    lines.push(secondary.join(" • "));
  }

  const command = activeCommand(value);
  if (command) {
    detailSection(lines, "▶ Current command", `$ ${safe(command.display_command)}`);
    detailSection(lines, "Command status", "Running");
  }

  if (value.current_task_status === "QUEUED") {
    detailSection(lines, "⏳ Waiting for", safe(value.waiting_resource ?? value.waiting_reason));
    detailSection(lines, "Resource", safe(value.resource_scope));
    detailSection(lines, "Owner", safe(value.lock_owner));
    detailSection(lines, "Waiting", elapsed(value.waiting_seconds));
  }

  const priorAttempt = allAttempts
    .filter((attempt) => attempt.attempt_number < (number ?? 1))
    .at(-1);
  if (value.current_task === "develop" && (number ?? 1) > 1 && priorAttempt) {
    detailSection(lines, "⚠️ Previous attempt", safe(priorAttempt.result_classification));
  }
  if (value.current_task === "develop" && value.attempt_escalation) {
    const interruption = priorAttempt?.result_classification === "EXECUTOR_FAILED";
    detailSection(
      lines,
      "⚡ Escalation reason",
      interruption
        ? "Prior implementation executor failed or was interrupted"
        : "Economical implementation attempts produced no candidate",
    );
  }

  const current = safe(value.current_activity ?? value.latest_safe_progress_message);
  detailSection(lines, "🎯 Current", current);
  // Live command and file activity stays in native rows. The bounded failed
  // Validation excerpt below is repeated so the terminal status is self-contained.
  const recent = safeActivities(value).filter(
    (activity) => !activity.entry_kind || activity.entry_kind === "activity",
  );
  listSection(lines, "📍 Recent activity", recent.map(activityLine));
  listSection(
    lines,
    "🔎 Checks",
    stageChecks.map((check) => stateLine(check.name, check.state)),
  );
  listSection(
    lines,
    "🔎 Evidence",
    evidence(value).map((item) => stateLine(item.message, item.state)),
  );

  if (
    value.status === "COMPLETED" &&
    value.outcome === "engineering_failure" &&
    allAttempts.length
  ) {
    listSection(lines, "🔁 Attempts", allAttempts.map(attemptLine));
  }
  const classification = safe(value.failure_classification);
  if (classification) detailSection(lines, "❌ Classification", classification);
  const diagnostic = value.failure_diagnostic;
  if (diagnostic) {
    if (diagnostic.failure_category)
      detailSection(lines, "Failure category", safe(diagnostic.failure_category));
    if (diagnostic.failure_code)
      detailSection(lines, "Failure reason code", safe(diagnostic.failure_code));
    detailSection(lines, "Failure reason", safe(diagnostic.summary));
    if (diagnostic.root_cause) detailSection(lines, "Root cause", safe(diagnostic.root_cause));
    if (diagnostic.recovery_strategy)
      detailSection(lines, "Recovery", safe(diagnostic.recovery_strategy));
    if (diagnostic.recommended_actions?.length)
      listSection(lines, "Recommended next actions", diagnostic.recommended_actions.map(safe));
    if (diagnostic.operator_action_required && diagnostic.operator_question)
      detailSection(lines, "Operator input", safe(diagnostic.operator_question));
  }
  const failedCheck = safe(value.validation_failed_check);
  if (failedCheck) detailSection(lines, "❌ Failed check", failedCheck);
  if (Number.isInteger(value.validation_exit_code))
    detailSection(lines, "Exit code", String(value.validation_exit_code));
  const failedCommand = safe(value.validation_command);
  if (failedCommand) detailSection(lines, "Command", failedCommand);
  if (
    Number.isInteger(value.validation_duration_ms) &&
    value.validation_duration_ms !== undefined &&
    value.validation_duration_ms !== null &&
    value.validation_duration_ms >= 0
  )
    detailSection(lines, "Duration", `${value.validation_duration_ms} ms`);
  const repairCount = value.validation_repair_count ?? 0;
  if (failedCheck || repairCount > 0)
    detailSection(lines, "🔁 Repairs", `${repairCount}/${value.validation_repair_limit ?? 2}`);
  const fingerprint = safe(value.validation_failure_fingerprint);
  if (fingerprint) detailSection(lines, "Failure fingerprint", fingerprint);
  terminalSection(lines, "Stdout", safeExcerpt(value.validation_stdout_excerpt));
  terminalSection(lines, "Stderr", safeExcerpt(value.validation_stderr_excerpt));
  const reviewFindings = (value.review_findings ?? [])
    .map((finding) => {
      const message = safe(finding.message);
      if (!message) return undefined;
      const location =
        finding.file && /^[^/\s][^\n]*$/.test(finding.file)
          ? `${finding.file}${Number.isInteger(finding.line) ? `:${finding.line}` : ""}: `
          : "";
      return `${finding.severity === "security" ? "🔒" : "•"} ${location}${message}`;
    })
    .filter((item): item is string => Boolean(item));
  if (reviewFindings.length) {
    listSection(lines, "🔎 Review findings", reviewFindings.slice(0, 8));
    detailSection(
      lines,
      "Next",
      "Provide repair instructions with `repair: <instructions>`; the preserved candidate will be used as the repair base.",
    );
  }
  if (value.status === "COMPLETED" && value.outcome && value.outcome !== "complete") {
    const recovery: string[] = [];
    if (value.candidate_sha && (value.outcome === "engineering_failure" || reviewFindings.length)) {
      recovery.push("**Repair:** `repair: <instructions>` — preserve and repair the candidate");
    }
    if (value.retryable_task_id) {
      recovery.push("**Retry:** `retry` — replay the one explicitly failed task");
    }
    if (value.outcome === "attention_required" && value.failure_diagnostic) {
      recovery.push(
        value.candidate_sha
          ? "**Fix it:** `repair: <instructions>` — continue from the preserved candidate"
          : "**Retry executor:** `Fix it` — start the bounded recovery strategy with persisted diagnostics",
      );
    }
    recovery.push("**Inspect:** `show workflow status` — refresh authoritative state");
    recovery.push("**Stop:** take no action and leave the candidate preserved");
    lines.push("", "🛠 Recovery options", "", ...recovery);
  }
  if (value.status === "COMPLETED" && !applicationDeliverySucceeded(value)) {
    detailSection(
      lines,
      value.outcome === "hard_stop" ? "🛑 Reason" : "❌ Reason",
      safe(value.summary),
    );
  }

  const candidate = shortSha(value.candidate_sha);
  if (candidate) detailSection(lines, "📦 Candidate", candidate);
  if (value.pr_url) {
    const numberFromUrl = value.pr_url.match(/\/pull\/(\d+)(?:$|[/?#])/)?.[1];
    detailSection(
      lines,
      "🔗 PR",
      safePrLink(value.pr_url, value.pr_number) ??
        (value.pr_number ? `#${value.pr_number}` : numberFromUrl ? `#${numberFromUrl}` : undefined),
    );
  }
  const merged = shortSha(value.merged_sha);
  if (merged) detailSection(lines, "📦 Merged SHA", merged);
  const deployed = shortSha(value.deployed_sha);
  if (deployed) detailSection(lines, "📦 Deployed", deployed);

  if (value.status === "COMPLETED") {
    detailSection(lines, "📌 Outcome", value.outcome ?? "unavailable");
    if (!value.deployed_sha && value.outcome !== "complete")
      detailSection(lines, "⏹ Deployment", "Not reached");
  }
  detailSection(lines, "⏭ Next", safe(value.next_action));
  detailSection(lines, "👤 Required action", safe(value.required_human_action));
  return lines.join("\n");
}

export function formatWorkflowStatus(value: WorkflowRecord): string {
  if (value.compact_progress && value.status !== "COMPLETED") return formatWorkflowProgress(value);

  const lines = [formatWorkflowProgress(value), "", hardLine("Authoritative workflow status")];
  const title = safe(value.original_task?.split(/\r?\n/, 1)[0]) ?? "Hatchet workflow";
  lines.push(hardLine(`Task: ${title.length <= 72 ? title : "Hatchet workflow"}`));
  lines.push(hardLine(`Hatchet run: ${value.run_id}`));
  lines.push(hardLine(`Project: ${value.project ?? "unknown"}`));
  lines.push(hardLine(`Execution: ${value.status}`));
  if (value.status === "COMPLETED") {
    lines.push(hardLine(`Outcome: ${value.outcome ?? "unavailable"}`));
    lines.push(hardLine(`Application state: ${terminalState(value)}`));
    line(lines, "Stopped at", taskMeta(value.stopped_at)?.name);
    line(lines, "Reason", safe(value.summary));
  }
  line(lines, "Current task", displayStage(value)?.name);
  line(lines, "Task status", value.current_task_status ?? undefined);
  lines.push(hardLine(`Candidate: ${shortSha(value.candidate_sha) ?? "none"}`));
  lines.push(hardLine(`PR: ${safePrLink(value.pr_url, value.pr_number) ?? "none"}`));
  line(lines, "GitHub checks", safe(value.github_check_summary));
  line(lines, "Merged", shortSha(value.merged_sha));
  line(lines, "UAT", safe(value.uat_status));
  lines.push(hardLine(`Deployment: ${shortSha(value.deployed_sha) ?? "not reached"}`));
  line(lines, "Waiting", safe(value.waiting_reason));
  line(lines, "Waiting resource", safe(value.waiting_resource));
  line(lines, "Resource scope", safe(value.resource_scope));
  line(lines, "Lock owner", safe(value.lock_owner));
  line(lines, "Time waiting", elapsed(value.waiting_seconds));
  return lines.join("\n");
}
