// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/** OWW's thin T3-to-Hatchet adapter. Hatchet is the only workflow state owner. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { EventId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationThreadActivity,
  ProviderApprovalDecision,
  TurnId,
} from "@t3tools/contracts";
import { workflowTransitionKey } from "./owwWorkflowStatus.ts";

const projectRoot = "/opt/agent-platform/projects/oww";
const hatchetBridge = "/opt/hatchet/venv/bin/oww-hatchet";
const conversationRun = new Map<string, string>();
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOwwWorkspace(workspace: string): boolean {
  let path = NodePath.resolve(workspace);
  try {
    path = NodeFS.realpathSync(path);
  } catch {
    /* Missing worktrees fail closed. */
  }
  return path === projectRoot || path.startsWith(projectRoot + NodePath.sep);
}

export type WorkflowOperation =
  | "start_task"
  | "get_run_status"
  | "get_run_details"
  | "approve_candidate"
  | "reject_candidate"
  | "approve_migration"
  | "reject_migration"
  | "cancel_run"
  | "retry_failed_task"
  | "recover_executor";

export type WorkflowTask = {
  task_id: string;
  name: string;
  status: string;
  output?: Record<string, unknown> | null;
  error?: string | null;
};

export type WorkflowActivity = {
  kind?: "t3_activity";
  message: string;
  state: "current" | "completed" | "warning" | "failed";
  executor_provider?: "codex" | "devin" | null;
  executor_model?: string | null;
  reasoning_effort?: string | null;
  entry_kind?: "activity" | "file" | "evidence" | "check" | "command" | undefined;
  role?: string | null;
  profile?: string | null;
  attempt_number?: number | null;
  attempt_limit?: number | null;
  escalation?: boolean;
  file_path?: string | null;
  file_operation?: "read" | "search" | "update" | "create" | "delete" | null;
  stage?: string | null;
  sequence?: number | null;
  execution_id?: string | null;
  observed_at?: string | null;
  event_kind?: string | null;
  correlation_id?: string | null;
  activity_key?: string | null;
  stream?: "stdout" | "stderr" | null;
  output_chunk?: string | null;
  display_command?: string | null;
  safe_cwd?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  exit_code?: number | null;
};

type NonCommandActivity = Omit<WorkflowActivity, "entry_kind"> & {
  entry_kind?: "activity" | "file" | "evidence" | "check" | undefined;
};

export type CommandActivity = Omit<WorkflowActivity, "entry_kind"> & {
  entry_kind: "command";
  command_id: string;
  stage: string;
  display_command: string;
  safe_cwd?: string | null;
  command_state: "started" | "completed" | "failed" | "timed_out";
  started_at: string;
  finished_at?: string | null;
  duration_ms?: number | null;
  exit_code?: number | null;
  stdout_excerpt?: string | null;
  stderr_excerpt?: string | null;
};

export type WorkflowCheck = {
  name: string;
  state: "passed" | "failed" | "pending" | "running" | "warning";
};

export type WorkflowEvidence = {
  message: string;
  state: "passed" | "failed" | "pending" | "running" | "warning";
};

export type DevelopmentAttempt = {
  attempt_number: number;
  attempt_limit?: number | null;
  role: string;
  profile: string;
  provider: "codex" | "devin";
  model: string;
  result_classification: string;
  candidate_sha?: string | null;
  escalation: boolean;
  executor_exit_code?: number | null;
};

export type WorkflowRecord = {
  readonly [key: string]: unknown;
  run_id: string;
  status: string;
  project?: string | null;
  original_task?: string | null;
  work_kind?: "application_change" | "platform_smoke" | null;
  outcome?:
    | "complete"
    | "attention_required"
    | "engineering_failure"
    | "hard_stop"
    | "rejected"
    | "smoke_complete"
    | null;
  summary?: string | null;
  current_task?: string | null;
  current_task_status?: string | null;
  stopped_at?: string | null;
  candidate_sha?: string | null;
  pr_url?: string | null;
  github_check_summary?: string | null;
  merged_sha?: string | null;
  uat_status?: string | null;
  deployed_sha?: string | null;
  waiting_reason?: string | null;
  waiting_resource?: string | null;
  resource_scope?: string | null;
  lock_owner?: string | null;
  waiting_seconds?: number | null;
  required_human_action?: string | null;
  latest_safe_progress_message?: string | null;
  executor_provider?: "codex" | "devin" | null;
  executor_model?: string | null;
  executor_reasoning_effort?: string | null;
  current_activity?: string | null;
  recent_actions?: WorkflowActivity[];
  command_events?: CommandActivity[];
  executor_events?: WorkflowActivity[];
  stage_started_at?: string | null;
  stage_elapsed_seconds?: number | null;
  attempt_number?: number | null;
  attempt_limit?: number | null;
  attempt_role?: string | null;
  attempt_profile?: string | null;
  attempt_escalation?: boolean;
  development_attempts?: DevelopmentAttempt[];
  safe_files?: string[];
  checks?: WorkflowCheck[];
  evidence?: WorkflowEvidence[];
  failure_classification?: string | null;
  failure_diagnostic?: {
    failure_category?: string | null;
    failure_code?: string | null;
    failure_code?: string | null;
    stage?: string | null;
    summary?: string | null;
    root_cause?: string | null;
    raw_error?: string | null;
    stderr_excerpt?: string | null;
    stdout_excerpt?: string | null;
    failed_command?: string | null;
    exit_code?: number | null;
    failed_check?: string | null;
    candidate_sha?: string | null;
    retryable?: boolean;
    recovery_strategy?: string | null;
    recommended_actions?: string[];
    operator_action_required?: boolean;
    operator_question?: string | null;
    diagnostic_evidence?: string[];
  } | null;
  recovery_decision?: {
    disposition?: string | null;
    reason?: string | null;
    strategy?: string | null;
    attempt?: number | null;
    operator_action_required?: boolean;
  } | null;
  candidate_history?: string[];
  candidate_revisions?: Array<Record<string, unknown>>;
  repair_attempts?: Array<Record<string, unknown>>;
  active_candidate_sha?: string | null;
  latest_candidate_sha?: string | null;
  validated_candidate_sha?: string | null;
  candidate_revision_count?: number;
  recovery_phase?: string | null;
  validation_failed_check?: string | null;
  validation_failed_kind?: "build" | "test" | "restore" | "deployment" | "security" | null;
  validation_exit_code?: number | null;
  validation_failure_fingerprint?: string | null;
  validation_command?: string | null;
  validation_duration_ms?: number | null;
  validation_stdout_excerpt?: string | null;
  validation_stderr_excerpt?: string | null;
  validation_repair_count?: number | null;
  validation_repair_limit?: number | null;
  validation_targeted?: boolean;
  review_findings?: Array<{
    severity?: string;
    file?: string | null;
    line?: number | null;
    message?: string;
  }>;
  pr_number?: number | null;
  next_action?: string | null;
  recovery_prompts?: RecoveryPrompt[];
  retryable_task_id?: string | null;
  retryable_task_name?: string | null;
  compact_progress?: boolean;
  tasks?: WorkflowTask[];
};

export type RecoveryPrompt = {
  option: string;
  title: string;
  prompt: string;
};

export type WorkflowStageState = "running" | "completed" | "failed" | "cancelled";

export type StageActivity = {
  entry_kind: "stage";
  run_id: string;
  stage: string;
  task_id: string;
  title: string;
  stage_state: WorkflowStageState;
  observed_at: string;
  started_at?: string | null | undefined;
  duration_ms?: number | null | undefined;
  detail?: string | null | undefined;
  compact_detail?: string | null | undefined;
  executor_provider?: "codex" | "devin" | null | undefined;
  executor_model?: string | null | undefined;
  reasoning_effort?: string | null | undefined;
  attempt_number?: number | null | undefined;
  attempt_limit?: number | null | undefined;
};

export type OwwApprovalAction = "candidate" | "migration" | "retry" | "cancel";

export type ApprovalActivity = {
  entry_kind: "approval";
  approval_state: "requested" | "resolved";
  request_id: string;
  action: OwwApprovalAction;
  run_id: string;
  observed_at: string;
  detail: string;
  exact_sha?: string | null | undefined;
  task_run_id?: string | null | undefined;
  decision?: ProviderApprovalDecision | null | undefined;
};

export type WorkflowTelemetry =
  | CommandActivity
  | NonCommandActivity
  | StageActivity
  | ApprovalActivity;

const workflowStages: Record<string, { name: string; icon: string }> = {
  "prepare-run": { name: "Prepare", icon: "⏳" },
  plan: { name: "Planning", icon: "🧠" },
  develop: { name: "Development", icon: "🛠" },
  validate: { name: "Validation", icon: "🧪" },
  review: { name: "Review", icon: "🔍" },
  "candidate-approval": { name: "Candidate Approval", icon: "🟡" },
  "publish-pull-request": { name: "Publishing", icon: "📤" },
  "github-check-status": { name: "CI", icon: "🔄" },
  "merge-exact-candidate": { name: "Merge", icon: "🔀" },
  "inspect-uat": { name: "UAT Inspection", icon: "🗄" },
  "migration-approval": { name: "Migration Approval", icon: "🗃" },
  "prepare-uat-backup": { name: "UAT Backup", icon: "💾" },
  "deploy-uat-exact-sha": { name: "UAT Deployment", icon: "🚢" },
  "verify-uat": { name: "UAT Verification", icon: "🩺" },
};

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const sha = "[0-9a-f]{40}";
const shaApprovalRequestPattern = new RegExp(
  `^hatchet:(${uuid}):(candidate|migration):(${sha})$`,
  "i",
);
const taskApprovalRequestPattern = new RegExp(`^hatchet:(${uuid}):(retry|cancel):(${uuid})$`, "i");
const unsafeTelemetry =
  /(?:secret|token|password|credential|private[ _-]?key|authorization|bearer|api[ _-]?key|chain[ -]of[ -]thought|hidden reasoning|(?:system|developer|user) prompt)/i;

const safeTelemetryText = (value?: string | null, limit = 240): string | undefined => {
  if (!value || unsafeTelemetry.test(value) || /(?:^|\s)\/(?!\/)/.test(value)) return undefined;
  return (
    value
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit) || undefined
  );
};

const shortSha = (value?: string | null) =>
  value && /^[0-9a-f]{40}$/i.test(value) ? value.slice(0, 12) : undefined;

const formatDuration = (durationMs?: number | null): string | undefined => {
  if (
    !Number.isFinite(durationMs) ||
    durationMs === undefined ||
    durationMs === null ||
    durationMs < 0
  )
    return undefined;
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
};

export function workflowStageKey(value: WorkflowRecord): string | null {
  if (value.current_task === "application-change" && value.current_task_status === "WAITING") {
    if (value.waiting_reason?.includes("migration approval")) return "migration-approval";
    if (value.waiting_reason?.includes("candidate approval")) return "candidate-approval";
  }
  const stage = value.current_task ?? value.stopped_at;
  return stage && Object.hasOwn(workflowStages, stage) ? stage : null;
}

export const workflowStageTaskId = (runId: string, stage: string) => `hatchet:${runId}:${stage}`;

function stageDetail(value: WorkflowRecord, stage: string): string | undefined {
  const lines: string[] = [];
  const provider =
    value.executor_provider === "codex"
      ? "Codex"
      : value.executor_provider === "devin"
        ? "Devin"
        : undefined;
  const model = safeTelemetryText(value.executor_model);
  const reasoning = safeTelemetryText(value.executor_reasoning_effort);
  if (provider && model)
    lines.push(`${provider} / ${model}${reasoning ? ` · ${reasoning} reasoning` : ""}`);
  if (value.attempt_number && value.attempt_limit)
    lines.push(`Attempt ${value.attempt_number}/${value.attempt_limit}`);
  if (value.attempt_escalation) lines.push("Escalation: stronger coding profile selected");
  if (stage === "plan" || stage === "review") lines.push("Safety: read-only worktree");
  const current = safeTelemetryText(value.current_activity ?? value.latest_safe_progress_message);
  if (current) lines.push(`Current: ${current}`);
  const classification = safeTelemetryText(value.failure_classification);
  if (classification) lines.push(`Classification: ${classification}`);
  const failedCheck = safeTelemetryText(value.validation_failed_check);
  if (failedCheck) lines.push(`Failed check: ${failedCheck}`);
  if (Number.isInteger(value.validation_exit_code))
    lines.push(`Exit code: ${value.validation_exit_code}`);
  if (failedCheck || (value.validation_repair_count ?? 0) > 0)
    lines.push(
      `Repairs: ${value.validation_repair_count ?? 0}/${value.validation_repair_limit ?? 2}`,
    );
  const fingerprint = safeTelemetryText(value.validation_failure_fingerprint);
  if (fingerprint) lines.push(`Failure fingerprint: ${fingerprint.slice(0, 24)}`);
  if (
    value.status === "FAILED" ||
    value.outcome === "engineering_failure" ||
    value.outcome === "hard_stop"
  ) {
    const reason = safeTelemetryText(value.summary);
    if (reason) lines.push(`Reason: ${reason}`);
  }
  const checks = (value.checks ?? []).slice(0, 20);
  if (checks.length > 0) {
    const passed = checks.filter((check) => check.state === "passed").length;
    lines.push(`Checks: ${passed}/${checks.length} passed`);
    for (const check of checks) {
      const name = safeTelemetryText(check.name, 160);
      if (name)
        lines.push(
          `${check.state === "passed" ? "✅" : check.state === "failed" ? "❌" : check.state === "running" ? "▶️" : check.state === "warning" ? "⚠️" : "⏳"} ${name}`,
        );
    }
  }
  for (const evidence of (value.evidence ?? []).slice(0, 12)) {
    const message = safeTelemetryText(evidence.message, 160);
    if (message)
      lines.push(
        `${evidence.state === "passed" ? "✅" : evidence.state === "failed" ? "❌" : evidence.state === "warning" ? "⚠️" : evidence.state === "running" ? "▶️" : "⏳"} ${message}`,
      );
  }
  const candidate = shortSha(value.candidate_sha);
  if (candidate) lines.push(`Candidate: ${candidate}`);
  const merged = shortSha(value.merged_sha);
  if (merged) lines.push(`Merged SHA: ${merged}`);
  const deployed = shortSha(value.deployed_sha);
  if (deployed) lines.push(`Deployed SHA: ${deployed}`);
  const next = safeTelemetryText(value.next_action);
  if (next) lines.push(`Next: ${next}`);
  const required = safeTelemetryText(value.required_human_action);
  if (required) lines.push(`Required action: ${required}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function workflowStageActivity(
  value: WorkflowRecord,
  observedAt: string,
): StageActivity | null {
  const stage = workflowStageKey(value);
  if (!stage) return null;
  const meta = workflowStages[stage]!;
  const durationMs = Number.isInteger(value.stage_elapsed_seconds)
    ? Math.max(0, value.stage_elapsed_seconds ?? 0) * 1000
    : null;
  let stageState: WorkflowStageState = "running";
  if (value.status === "CANCELLED" || value.outcome === "rejected") stageState = "cancelled";
  else if (
    value.status === "FAILED" ||
    value.current_task_status === "FAILED" ||
    value.outcome === "engineering_failure" ||
    value.outcome === "hard_stop"
  )
    stageState = "failed";
  else if (value.status === "COMPLETED") stageState = "completed";
  const duration = formatDuration(durationMs);
  const stateLabel =
    stageState === "running" && value.current_task_status === "WAITING"
      ? "ACTION REQUIRED"
      : stageState.toUpperCase();
  const marker =
    stageState === "completed"
      ? "✅"
      : stageState === "failed"
        ? "🛑"
        : stageState === "cancelled"
          ? "❌"
          : "▶️";
  const title = `${marker} ${meta.icon} ${meta.name} · ${stateLabel}${duration ? ` · ${duration}` : ""}`;
  const compact: string[] = [];
  const model = safeTelemetryText(value.executor_model);
  if (model) compact.push(model);
  if (stage === "develop" && value.attempt_number && value.attempt_limit)
    compact.push(`Attempt ${value.attempt_number}/${value.attempt_limit}`);
  const candidate = shortSha(value.candidate_sha);
  if (candidate && (stage === "develop" || stage === "candidate-approval"))
    compact.push(`Candidate ${candidate}`);
  if (stage === "validate" && value.checks?.length) {
    compact.push(
      `${value.checks.filter((check) => check.state === "passed").length}/${value.checks.length} checks`,
    );
  }
  return {
    entry_kind: "stage",
    run_id: value.run_id,
    stage,
    task_id: workflowStageTaskId(value.run_id, stage),
    title,
    stage_state: stageState,
    observed_at: observedAt,
    started_at: value.stage_started_at,
    duration_ms: durationMs,
    detail: stageDetail(value, stage),
    compact_detail: compact.join(" · ") || null,
    executor_provider: value.executor_provider,
    executor_model: model,
    reasoning_effort: safeTelemetryText(value.executor_reasoning_effort),
    attempt_number: value.attempt_number,
    attempt_limit: value.attempt_limit,
  };
}

export function completeStageActivity(
  activity: StageActivity,
  state: Exclude<WorkflowStageState, "running"> = "completed",
  observedAt = DateTime.formatIso(DateTime.nowUnsafe()),
): StageActivity {
  const meta = workflowStages[activity.stage] ?? { name: activity.stage, icon: "⏳" };
  const duration = formatDuration(activity.duration_ms);
  const marker = state === "completed" ? "✅" : state === "failed" ? "🛑" : "❌";
  return {
    ...activity,
    stage_state: state,
    observed_at: observedAt,
    title: `${marker} ${meta.icon} ${meta.name} · ${state.toUpperCase()}${duration ? ` · ${duration}` : ""}`,
    detail: state === "completed" ? activity.compact_detail : activity.detail,
  };
}

export function stageActivityToNative(
  activity: StageActivity,
  turnId: TurnId | null = null,
): OrchestrationThreadActivity {
  const terminal = activity.stage_state !== "running";
  return {
    id: EventId.make(activity.task_id),
    tone: activity.stage_state === "failed" ? "error" : "info",
    kind: terminal ? "task.completed" : "task.progress",
    summary: activity.title,
    payload: {
      taskId: activity.task_id,
      taskType: "hatchet_stage",
      stage: activity.stage,
      status:
        activity.stage_state === "running"
          ? "running"
          : activity.stage_state === "cancelled"
            ? "stopped"
            : activity.stage_state,
      summary: activity.title,
      ...(activity.detail ? { detail: activity.detail } : {}),
      ...(activity.started_at ? { startedAt: activity.started_at } : {}),
      durationMs: activity.duration_ms ?? null,
      provider: activity.executor_provider ?? null,
      model: activity.executor_model ?? null,
      reasoningEffort: activity.reasoning_effort ?? null,
      attemptNumber: activity.attempt_number ?? null,
      attemptLimit: activity.attempt_limit ?? null,
    },
    turnId,
    createdAt: activity.observed_at,
  };
}

const commandSignature = (activity: CommandActivity) =>
  JSON.stringify([
    activity.command_state,
    activity.finished_at,
    activity.duration_ms,
    activity.exit_code,
    activity.stdout_excerpt,
    activity.stderr_excerpt,
    activity.sequence,
    activity.output_chunk,
    activity.execution_id,
  ]);

/** Maps Hatchet telemetry into the exact activity type used by normal provider tools. */
export function commandActivityToNative(
  activity: CommandActivity,
  id: EventId,
  turnId: TurnId | null = null,
): OrchestrationThreadActivity {
  const running = activity.command_state === "started";
  const failed = activity.command_state !== "completed" && !running;
  return {
    id,
    tone: "tool",
    kind: running ? "tool.updated" : "tool.completed",
    summary: activity.display_command,
    payload: {
      itemType: "command_execution",
      toolCallId: activity.command_id,
      status: running ? "inProgress" : failed ? "failed" : "completed",
      title: activity.display_command,
      detail: activity.display_command,
      data: {
        kind: "execute",
        command: activity.display_command,
        cwd: activity.safe_cwd ?? ".",
        rawOutput: {
          ...(activity.stream === "stdout" && activity.output_chunk
            ? { stdout: activity.output_chunk }
            : {}),
          ...(activity.stream === "stderr" && activity.output_chunk
            ? { stderr: activity.output_chunk }
            : {}),
          ...(activity.stdout_excerpt ? { stdout: activity.stdout_excerpt } : {}),
          ...(activity.stderr_excerpt ? { stderr: activity.stderr_excerpt } : {}),
        },
        stage: activity.stage,
        attemptNumber: activity.attempt_number ?? null,
        provider: activity.executor_provider ?? null,
        model: activity.executor_model ?? null,
        durationMs: activity.duration_ms ?? null,
        exitCode: activity.exit_code ?? null,
        timedOut: activity.command_state === "timed_out",
      },
    },
    turnId,
    createdAt: activity.observed_at ?? activity.finished_at ?? activity.started_at,
  };
}

export function fileActivityToNative(
  activity: WorkflowActivity,
  id: EventId,
  createdAt: string,
  turnId: TurnId | null = null,
): OrchestrationThreadActivity | null {
  if (activity.entry_kind !== "file" || !activity.file_path || !activity.file_operation)
    return null;
  const toolCallId = `hatchet-file:${activity.file_operation}:${activity.file_path}`;
  const read = activity.file_operation === "read";
  const search = activity.file_operation === "search";
  return {
    id,
    tone: "tool",
    kind: "tool.completed",
    summary: activity.message,
    payload: {
      itemType: read ? "dynamic_tool_call" : search ? "web_search" : "file_change",
      toolCallId,
      status: "completed",
      title: read ? "Read file" : search ? "Grep code" : activity.message,
      ...(read ? { requestKind: "file-read" } : {}),
      data: {
        toolCallId,
        ...(read
          ? { item: { path: activity.file_path, operation: "read" } }
          : search
            ? { item: { path: activity.file_path, operation: "search" } }
            : { item: { changes: [{ path: activity.file_path, kind: activity.file_operation }] } }),
        stage: activity.stage ?? null,
        attemptNumber: activity.attempt_number ?? null,
      },
    },
    turnId,
    createdAt,
  };
}

export type WorkflowCall = (
  name: WorkflowOperation,
  args: Record<string, string>,
) => Promise<WorkflowRecord>;

type ParsedOwwApproval = {
  runId: string;
  action: OwwApprovalAction;
  exactSha?: string;
  taskRunId?: string;
};

export function parseOwwApprovalRequestId(requestId: string): ParsedOwwApproval | null {
  const shaMatch = shaApprovalRequestPattern.exec(requestId);
  if (shaMatch) {
    return {
      runId: shaMatch[1]!.toLowerCase(),
      action: shaMatch[2]!.toLowerCase() as "candidate" | "migration",
      exactSha: shaMatch[3]!.toLowerCase(),
    };
  }
  const taskMatch = taskApprovalRequestPattern.exec(requestId);
  if (!taskMatch) return null;
  return {
    runId: taskMatch[1]!.toLowerCase(),
    action: taskMatch[2]!.toLowerCase() as "retry" | "cancel",
    taskRunId: taskMatch[3]!.toLowerCase(),
  };
}

const isCandidateWait = (value: WorkflowRecord) =>
  value.status === "RUNNING" &&
  value.current_task_status === "WAITING" &&
  value.waiting_reason?.includes("candidate approval") === true;

const isMigrationWait = (value: WorkflowRecord) =>
  value.status === "RUNNING" &&
  value.current_task_status === "WAITING" &&
  value.waiting_reason?.includes("migration approval") === true;

const candidateApprovalRequestId = (value: WorkflowRecord) =>
  value.candidate_sha && /^[0-9a-f]{40}$/i.test(value.candidate_sha)
    ? `hatchet:${value.run_id}:candidate:${value.candidate_sha.toLowerCase()}`
    : null;

const migrationApprovalRequestId = (value: WorkflowRecord) =>
  value.merged_sha && /^[0-9a-f]{40}$/i.test(value.merged_sha)
    ? `hatchet:${value.run_id}:migration:${value.merged_sha.toLowerCase()}`
    : null;

export function workflowApprovalActivities(
  value: WorkflowRecord,
  observedAt: string,
): ApprovalActivity[] {
  const activities: ApprovalActivity[] = [];
  const candidateRequestId = candidateApprovalRequestId(value);
  if (candidateRequestId && isCandidateWait(value)) {
    activities.push({
      entry_kind: "approval",
      approval_state: "requested",
      request_id: candidateRequestId,
      action: "candidate",
      run_id: value.run_id,
      observed_at: observedAt,
      exact_sha: value.candidate_sha,
      detail: `🟡 Candidate Approval\nACTION REQUIRED\n\n📦 Candidate ${shortSha(value.candidate_sha)}\n\nValidation and engineering review passed for this exact candidate.`,
    });
  } else if (
    candidateRequestId &&
    (Boolean(value.pr_url) ||
      value.outcome === "rejected" ||
      [
        "publish-pull-request",
        "github-check-status",
        "merge-exact-candidate",
        "inspect-uat",
        "prepare-uat-backup",
        "deploy-uat-exact-sha",
        "verify-uat",
      ].includes(value.current_task ?? ""))
  ) {
    activities.push({
      entry_kind: "approval",
      approval_state: "resolved",
      request_id: candidateRequestId,
      action: "candidate",
      run_id: value.run_id,
      observed_at: observedAt,
      exact_sha: value.candidate_sha,
      detail: "Candidate approval resolved",
    });
  }

  const migrationRequestId = migrationApprovalRequestId(value);
  if (migrationRequestId && isMigrationWait(value)) {
    activities.push({
      entry_kind: "approval",
      approval_state: "requested",
      request_id: migrationRequestId,
      action: "migration",
      run_id: value.run_id,
      observed_at: observedAt,
      exact_sha: value.merged_sha,
      detail: `🟡 Migration Approval\nACTION REQUIRED\n\n📦 Merged SHA ${shortSha(value.merged_sha)}\n\nDatabase migration approval is required for this exact release.`,
    });
  } else if (
    migrationRequestId &&
    (value.outcome === "rejected" ||
      ["prepare-uat-backup", "deploy-uat-exact-sha", "verify-uat"].includes(
        value.current_task ?? value.stopped_at ?? "",
      ))
  ) {
    activities.push({
      entry_kind: "approval",
      approval_state: "resolved",
      request_id: migrationRequestId,
      action: "migration",
      run_id: value.run_id,
      observed_at: observedAt,
      exact_sha: value.merged_sha,
      detail: "Migration approval resolved",
    });
  }

  if (
    value.retryable_task_id &&
    runIdPattern.test(value.retryable_task_id) &&
    ["COMPLETED", "FAILED"].includes(value.status)
  ) {
    const name = safeTelemetryText(value.retryable_task_name) ?? "failed stage";
    activities.push({
      entry_kind: "approval",
      approval_state: "requested",
      request_id: `hatchet:${value.run_id}:retry:${value.retryable_task_id}`,
      action: "retry",
      run_id: value.run_id,
      observed_at: observedAt,
      task_run_id: value.retryable_task_id,
      detail: `🛑 ${name} · FAILED\n\nRetry only this explicitly failed Hatchet task. Earlier successful stages will not be restarted.`,
    });
  }
  return activities;
}

export function approvalActivityToNative(
  activity: ApprovalActivity,
  turnId: TurnId | null = null,
): OrchestrationThreadActivity {
  const requested = activity.approval_state === "requested";
  const labels =
    activity.action === "retry"
      ? { accept: "Retry failed stage", decline: "Dismiss" }
      : activity.action === "cancel"
        ? { accept: "Cancel workflow", decline: "Keep running" }
        : { accept: "Approve", decline: "Reject" };
  return {
    id: EventId.make(`hatchet-approval:${activity.approval_state}:${activity.request_id}`),
    tone: "approval",
    kind: requested ? "approval.requested" : "approval.resolved",
    summary: requested
      ? activity.action === "candidate"
        ? "Candidate approval required"
        : activity.action === "migration"
          ? "Migration approval required"
          : activity.action === "retry"
            ? "Failed stage can be retried"
            : "Cancel workflow"
      : "Hatchet action resolved",
    payload: {
      requestId: activity.request_id,
      requestKind: "command",
      requestType: "dynamic_tool_call",
      detail: activity.detail,
      owwAction: activity.action,
      runId: activity.run_id,
      ...(activity.exact_sha ? { exactSha: activity.exact_sha } : {}),
      ...(activity.task_run_id ? { taskRunId: activity.task_run_id } : {}),
      ...(requested
        ? {
            options: [
              { decision: "accept", label: labels.accept },
              { decision: "decline", label: labels.decline },
            ],
          }
        : { decision: activity.decision ?? "accept" }),
    },
    turnId,
    createdAt: activity.observed_at,
  };
}

export type OwwApprovalResolution =
  | { handled: false }
  | {
      handled: true;
      workflow: WorkflowRecord;
      action: OwwApprovalAction;
      resume: boolean;
      decision: ProviderApprovalDecision;
    };

export function createOwwApprovalResolutionGuard() {
  const pending = new Set<string>();
  const resolved = new Set<string>();
  return {
    begin(requestId: string): boolean {
      if (pending.has(requestId) || resolved.has(requestId)) return false;
      pending.add(requestId);
      return true;
    },
    resolve(requestId: string): void {
      pending.delete(requestId);
      resolved.add(requestId);
    },
    finish(requestId: string): void {
      pending.delete(requestId);
    },
  };
}

export async function resolveOwwApprovalAction(input: {
  requestId: string;
  decision: ProviderApprovalDecision;
  threadId: string;
  call?: WorkflowCall;
}): Promise<OwwApprovalResolution> {
  const parsed = parseOwwApprovalRequestId(input.requestId);
  if (!parsed) return { handled: false };
  const call = input.call ?? callWorkflowTool;
  const details = await call("get_run_details", { run_id: parsed.runId });
  if (details.run_id !== parsed.runId || details.project !== "oww")
    throw new Error("stale Hatchet approval: run identity changed");
  const accepted = ["accept", "acceptForSession", "acceptAlways"].includes(input.decision);
  let workflow = details;
  let resume = false;
  if (parsed.action === "candidate") {
    if (details.candidate_sha?.toLowerCase() !== parsed.exactSha)
      throw new Error("stale Hatchet candidate approval");
    // Approval delivery can race with the workflow advancing after another
    // delivery of the same exact request. Treat that exact candidate as
    // already resolved instead of reporting a misleading expired action.
    if (!isCandidateWait(details)) {
      return {
        handled: true,
        workflow: details,
        action: parsed.action,
        resume: details.status === "RUNNING",
        decision: input.decision,
      };
    }
    workflow = await call(accepted ? "approve_candidate" : "reject_candidate", {
      run_id: parsed.runId,
      candidate_sha: parsed.exactSha!,
      reviewer_identity: reviewer(input.threadId),
      comment: "Native T3 candidate decision",
    });
    resume = true;
  } else if (parsed.action === "migration") {
    if (details.merged_sha?.toLowerCase() !== parsed.exactSha)
      throw new Error("stale Hatchet migration approval");
    if (!isMigrationWait(details)) {
      return {
        handled: true,
        workflow: details,
        action: parsed.action,
        resume: details.status === "RUNNING",
        decision: input.decision,
      };
    }
    workflow = await call(accepted ? "approve_migration" : "reject_migration", {
      run_id: parsed.runId,
      merged_sha: parsed.exactSha!,
      reviewer_identity: reviewer(input.threadId),
      comment: "Native T3 migration decision",
    });
    resume = true;
  } else if (parsed.action === "retry") {
    const failed = (details.tasks ?? []).filter((task) => task.status === "FAILED");
    if (
      details.retryable_task_id !== parsed.taskRunId ||
      failed.length !== 1 ||
      failed[0]?.task_id !== parsed.taskRunId
    )
      throw new Error("stale Hatchet retry action");
    if (accepted) {
      workflow = await call("retry_failed_task", {
        run_id: parsed.runId,
        task_run_id: parsed.taskRunId!,
      });
      resume = true;
    }
  } else {
    if (details.status !== "RUNNING") throw new Error("stale Hatchet cancel action");
    if (accepted) workflow = await call("cancel_run", { run_id: parsed.runId });
  }
  return {
    handled: true,
    workflow,
    action: parsed.action,
    resume,
    decision: input.decision,
  };
}

export const callWorkflowTool: WorkflowCall = (name, args) =>
  new Promise((accept, reject) => {
    const child = NodeChildProcess.spawn(hatchetBridge, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Hatchet bridge timed out; query the same run ID again."));
    }, 30_000);
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      output += data;
      if (output.length > 2_000_000) {
        child.kill();
        reject(new Error("Hatchet bridge response too large"));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
      stderr = (stderr + data)
        .slice(-500)
        .replace(/(?:token|secret|password|credential)\S*/gi, "[redacted]");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error(`Hatchet bridge exited (${code}): ${stderr}`);
        const responses = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const response = responses.find((item) => item.id === 2);
        if (!response || response.error || response.result?.isError)
          throw new Error(response?.error?.message ?? "Hatchet bridge operation failed");
        const record = JSON.parse(response.result.content[0].text) as WorkflowRecord;
        if (!runIdPattern.test(record.run_id) || typeof record.status !== "string")
          throw new Error("Hatchet bridge returned no valid run ID/status");
        accept(record);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "t3-oww", version: "2" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
    );
  });

export function classifyOwwRequest(text: string): "read_only" | "administration" | "workflow" {
  const value = text.trim();
  if (/^Platform administration:\s*\S/i.test(value)) return "administration";
  if (
    /^(?:explain (?:this|the) code|show current configuration|summarize (?:a |the )?(?:PR|pull request)(?: #?\d+)?|inspect logs)[.!?]?$/i.test(
      value,
    )
  )
    return "read_only";
  return "workflow";
}

export type WorkflowRequest = {
  workspace: string;
  threadId: string;
  messageId: string;
  text: string;
  hasAttachments?: boolean;
};
export type WorkflowSubmission =
  | { handled: false }
  | { handled: true; workflow: WorkflowRecord; resume: boolean; notice?: string };

const explicitRepairFrom = (text: string) =>
  text.match(/^\s*(?:repair|remediate)(?:\s+[0-9a-f-]{36})?\s*:\s*(\S[\s\S]*)$/i)?.[1]?.trim();

const reviewFindingsForRepair = (value: WorkflowRecord): string[] => {
  const findings: string[] = [];
  for (const task of value.tasks ?? []) {
    if (task.name !== "review" || !task.output) continue;
    const raw = task.output.findings;
    if (!Array.isArray(raw)) continue;
    for (const finding of raw) {
      if (!finding || typeof finding !== "object") continue;
      const item = finding as {
        file?: unknown;
        line?: unknown;
        message?: unknown;
        severity?: unknown;
      };
      if (typeof item.message !== "string") continue;
      const location =
        typeof item.file === "string"
          ? `${item.file}${typeof item.line === "number" ? `:${item.line}` : ""}: `
          : "";
      findings.push(
        `[${typeof item.severity === "string" ? item.severity : "finding"}] ${location}${item.message}`,
      );
    }
  }
  return [...new Set(findings)].slice(0, 20);
};

const controlKind = (
  text: string,
): Exclude<WorkflowOperation, "start_task" | "get_run_details"> | undefined => {
  // Human controls must be whole-message commands. Searching for these words
  // anywhere in an engineering request can turn task content into a control
  // action (or, in a fresh chat, a lookup for a run that cannot exist).
  if (/^\s*(?:please\s+)?approve\s+(?:the\s+)?migration(?:\s+[0-9a-f]{40})?\s*[.!]?$/i.test(text))
    return "approve_migration";
  if (/^\s*(?:please\s+)?reject\s+(?:the\s+)?migration(?:\s+[0-9a-f]{40})?\s*[.!]?$/i.test(text))
    return "reject_migration";
  if (
    /^\s*(?:please\s+)?approve(?:\s+(?:the\s+)?candidate)?(?:\s+(?:for\s+)?[0-9a-f-]{36})?(?:\s+(?:for\s+)?[0-9a-f]{40})?\s*[.!]?$/i.test(
      text,
    )
  )
    return "approve_candidate";
  if (
    /^\s*(?:please\s+)?reject(?:\s+(?:the\s+)?candidate)?(?:\s+(?:for\s+)?[0-9a-f-]{36})?(?:\s+(?:for\s+)?[0-9a-f]{40})?\s*[.!]?$/i.test(
      text,
    )
  )
    return "reject_candidate";
  if (/^\s*(?:please\s+)?cancel(?:\s+(?:the\s+)?run)?\s*[.!]?$/i.test(text)) return "cancel_run";
  if (
    /^\s*(?:please\s+)?(?:retry|replay)(?:\s+(?:the\s+)?(?:failed\s+)?task)?(?:\s+[0-9a-f-]{36})?\s*[.!]?$/i.test(
      text,
    )
  )
    return "retry_failed_task";
  if (/^\s*(?:please\s+)?fix(?:\s+it)?\s*[.!]?$/i.test(text)) return "recover_executor";
  if (
    /^\s*(?:(?:show|check)\s+)?(?:(?:workflow|run)\s+)?(?:status|progress|continue)(?:\s+(?:workflow|run))?(?:\s+[0-9a-f-]{36})?\s*[.!]?\s*$/i.test(
      text,
    )
  )
    return "get_run_status";
  if (
    /[;.!?]\s*(?:(?:show|check)\s+)?(?:(?:workflow|run)\s+)?(?:status|progress)(?:\s+(?:workflow|run))?(?:\s+[0-9a-f-]{36})?\s*[.!?]?\s*$/i.test(
      text,
    )
  )
    return "get_run_status";
  if (
    /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(text) &&
    /\b(?:status|progress|continue)\b/i.test(text)
  )
    return "get_run_status";
  return undefined;
};

const exactShaFrom = (text: string) => text.match(/\b[0-9a-f]{40}\b/i)?.[0]?.toLowerCase();
const explicitRunFrom = (text: string) =>
  text
    .match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0]
    ?.toLowerCase();
const reviewer = (threadId: string) =>
  `t3-conversation:${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`;
const conversationCorrelation = (threadId: string) =>
  `t3-${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}`;

export async function submitOwwRequest(
  request: WorkflowRequest,
  call: WorkflowCall = callWorkflowTool,
): Promise<WorkflowSubmission> {
  const explicitRun = explicitRunFrom(request.text);
  const repairInstruction = explicitRepairFrom(request.text);
  // A new T3 chat may not yet have the OWW workspace selected. An explicit
  // repair run ID is safe to resolve first; the fetched run is still required
  // to belong to project `oww` before any new workflow is created.
  if (!isOwwWorkspace(request.workspace) && !(repairInstruction && explicitRun))
    return { handled: false };
  let boundRun = explicitRun ?? conversationRun.get(request.threadId);
  const explicitNewTask = request.text.match(
    /^\s*(?:start\s+(?:a\s+)?new\s+task|new\s+task)\s*:\s*(\S[\s\S]*)$/i,
  );
  const taskText = explicitNewTask?.[1] ?? request.text;
  const control = explicitNewTask ? undefined : controlKind(request.text);
  const forbidsCreation =
    /^\s*(?:do\s+not|don't|dont|must\s+not|never)\s+(?:create|start)(?:\s+another)?\s+(?:task|workflow|run)(?:\s*;\s*(?:show|check)\s+(?:run\s+)?status)?\s*[.!]?$/i.test(
      request.text,
    );
  const forbidsControl =
    /^\s*(?:do\s+not|don't|dont|must\s+not|never|no)\s+(?:(?:the\s+)?(?:candidate|migration|run)\s+)?(?:approve|reject|retry|replay|cancel)(?:\s+(?:the\s+)?(?:candidate|migration|run|task))?\s*[.!]?$/i.test(
      request.text,
    );

  if (control || forbidsCreation || forbidsControl) {
    let recovered: WorkflowRecord | undefined;
    if (!boundRun && control) {
      recovered = await call("get_run_details", {
        t3_conversation_id: conversationCorrelation(request.threadId),
      });
      boundRun = recovered.run_id;
    }
    if (!boundRun) {
      if (forbidsCreation || forbidsControl) return { handled: false };
      throw new Error(
        "This control request needs a Hatchet run ID or a run already bound to this conversation.",
      );
    }
    conversationRun.set(request.threadId, boundRun);
    const details = recovered ?? (await call("get_run_details", { run_id: boundRun }));
    if (details.project !== "oww") throw new Error("Hatchet run belongs to another project");
    if (!control) return { handled: true, workflow: details, resume: false };
    if (control === "get_run_status")
      return {
        handled: true,
        workflow: await call("get_run_status", { run_id: boundRun }),
        resume: false,
      };
    if (control === "approve_candidate" || control === "reject_candidate") {
      if (!details.candidate_sha)
        return {
          handled: true,
          workflow: details,
          resume: false,
          notice: "Candidate decision rejected: Hatchet has no exact candidate SHA for this run.",
        };
      const supplied = exactShaFrom(request.text);
      if (supplied && supplied !== details.candidate_sha)
        return {
          handled: true,
          workflow: details,
          resume: false,
          notice:
            "Candidate decision rejected: supplied SHA does not exactly match the Hatchet candidate.",
        };
      const workflow = await call(control, {
        run_id: boundRun,
        candidate_sha: details.candidate_sha,
        reviewer_identity: reviewer(request.threadId),
        comment: "Typed T3 candidate decision",
      });
      return { handled: true, workflow, resume: true };
    }
    if (control === "approve_migration" || control === "reject_migration") {
      if (!details.merged_sha)
        return {
          handled: true,
          workflow: details,
          resume: false,
          notice: "Migration decision rejected: Hatchet has no exact merged SHA for this run.",
        };
      const supplied = exactShaFrom(request.text);
      if (supplied && supplied !== details.merged_sha)
        return {
          handled: true,
          workflow: details,
          resume: false,
          notice:
            "Migration decision rejected: supplied SHA does not exactly match the Hatchet merged SHA.",
        };
      const workflow = await call(control, {
        run_id: boundRun,
        merged_sha: details.merged_sha,
        reviewer_identity: reviewer(request.threadId),
        comment: "Typed T3 migration decision",
      });
      return { handled: true, workflow, resume: true };
    }
    if (control === "retry_failed_task") {
      const failed = (details.tasks ?? []).filter((task) => task.status === "FAILED");
      if (failed.length !== 1)
        return {
          handled: true,
          workflow: details,
          resume: false,
          notice:
            "Retry requires exactly one explicitly failed Hatchet task; inspect run details first.",
        };
      const workflow = await call(control, { run_id: boundRun, task_run_id: failed[0]!.task_id });
      return { handled: true, workflow, resume: true };
    }
    if (control === "recover_executor") {
      const workflow = await call("recover_executor", {
        run_id: boundRun,
        t3_conversation_id: conversationCorrelation(request.threadId),
      });
      conversationRun.set(request.threadId, workflow.run_id);
      return { handled: true, workflow, resume: true };
    }
    return {
      handled: true,
      workflow: await call("cancel_run", { run_id: boundRun }),
      resume: false,
    };
  }

  if (repairInstruction) {
    let details: WorkflowRecord;
    if (boundRun) details = await call("get_run_details", { run_id: boundRun });
    else
      details = await call("get_run_details", {
        t3_conversation_id: conversationCorrelation(request.threadId),
      });
    if (details.project !== "oww") throw new Error("Hatchet run belongs to another project");
    if (
      !["engineering_failure", "attention_required"].includes(details.outcome ?? "") ||
      !details.candidate_sha
    ) {
      return {
        handled: true,
        workflow: details,
        resume: false,
        notice:
          "Repair requires a preserved engineering-failure candidate on the bound Hatchet run.",
      };
    }
    const findings = reviewFindingsForRepair(details);
    const task = [
      "Repair the preserved candidate from the previous OWW workflow run.",
      `Previous run: ${details.run_id}`,
      `Preserved candidate SHA: ${details.candidate_sha}`,
      "Do not discard or bypass the candidate; start from that exact SHA.",
      findings.length
        ? `Review findings:\n${findings.map((item) => `- ${item}`).join("\n")}`
        : "Review findings were unavailable; inspect the previous run details before changing code.",
      `Operator instructions:\n${repairInstruction}`,
    ].join("\n\n");
    const workflow = await call("start_task", {
      project_id: "oww",
      task,
      work_kind: "application_change",
      request_id: conversationCorrelation(request.threadId),
      execution_profile: "default",
      base_sha: details.candidate_sha,
      t3_conversation_id: conversationCorrelation(request.threadId),
    });
    conversationRun.set(request.threadId, workflow.run_id);
    return { handled: true, workflow, resume: true };
  }

  if (classifyOwwRequest(request.text) !== "workflow") return { handled: false };
  if (request.hasAttachments)
    throw new Error(
      "Hatchet task creation requires the complete engineering request as text; attachments are not forwarded.",
    );
  if (/^(?:yes(?: please)?|go ahead|do it|proceed|full scope)[.!]?$/i.test(request.text.trim()))
    throw new Error(
      "A short confirmation cannot create a Hatchet run; provide the complete new task or refer to the bound run.",
    );
  if (boundRun && !explicitNewTask) {
    const workflow = await call("get_run_status", { run_id: boundRun });
    return {
      handled: true,
      workflow,
      resume: false,
      notice:
        "This conversation is bound to the existing Hatchet run. Prefix a complete request with 'Start new task:' to create another run.",
    };
  }
  const task = taskText;
  const requestId =
    "t3-" +
    NodeCrypto.createHash("sha256")
      .update(JSON.stringify([request.threadId, request.messageId]))
      .digest("hex");
  const workflow = await call("start_task", {
    project_id: "oww",
    task,
    work_kind: "application_change",
    request_id: requestId,
    execution_profile: "default",
    t3_conversation_id: conversationCorrelation(request.threadId),
  });
  conversationRun.set(request.threadId, workflow.run_id);
  return { handled: true, workflow, resume: true };
}

/** Monitoring is a read-only projection. It never starts, resumes, or retries a run. */
export async function monitorOwwWorkflow(
  id: string,
  emit: (value: WorkflowRecord) => Promise<void>,
  call: WorkflowCall = callWorkflowTool,
  emitTelemetry?: (activity: WorkflowTelemetry) => Promise<void>,
): Promise<void> {
  let lastStatus = "";
  let lastStage: StageActivity | null = null;
  let lastStageSignature = "";
  const commandStates = new Map<string, string>();
  const executorSequences = new Map<string, number>();
  const fileStates = new Set<string>();
  const approvalStates = new Map<string, string>();
  for (;;) {
    const value = await call("get_run_status", { run_id: id });
    for (const event of value.executor_events ?? []) {
      const executionId = event.execution_id;
      const sequence = event.sequence;
      if (!executionId || !sequence) continue;
      if ((executorSequences.get(executionId) ?? 0) >= sequence) continue;
      executorSequences.set(executionId, sequence);
      const terminal =
        event.event_kind === "executor_completed" || event.event_kind === "executor_failed";
      const output: CommandActivity = {
        ...event,
        entry_kind: "command",
        command_id: event.correlation_id ?? `${executionId}:terminal`,
        stage: event.stage ?? value.current_task ?? "develop",
        display_command:
          event.display_command ??
          (event.event_kind === "activity_progress"
            ? event.message
            : `${event.executor_provider ?? "executor"} session`),
        command_state: terminal
          ? event.event_kind === "executor_failed"
            ? "failed"
            : "completed"
          : "started",
        started_at:
          event.started_at ?? event.observed_at ?? DateTime.formatIso(DateTime.nowUnsafe()),
        finished_at: event.finished_at ?? event.observed_at ?? null,
      };
      await emitTelemetry?.(output);
    }
    for (const activity of value.command_events ?? []) {
      const signature = commandSignature(activity);
      if (commandStates.get(activity.command_id) === signature) continue;
      commandStates.set(activity.command_id, signature);
      await emitTelemetry?.(activity);
    }
    for (const activity of value.recent_actions ?? []) {
      if (activity.entry_kind !== "file" || !activity.file_path || !activity.file_operation)
        continue;
      const signature = JSON.stringify([
        value.current_task,
        activity.file_operation,
        activity.file_path,
        activity.message,
        activity.attempt_number,
      ]);
      if (fileStates.has(signature)) continue;
      fileStates.add(signature);
      const fileActivity: NonCommandActivity = { ...activity, entry_kind: "file" };
      await emitTelemetry?.(fileActivity);
    }
    const observedAt = DateTime.formatIso(DateTime.nowUnsafe());
    const stage = workflowStageActivity(value, observedAt);
    if (stage && lastStage && stage.task_id !== lastStage.task_id) {
      await emitTelemetry?.(completeStageActivity(lastStage, "completed", observedAt));
      lastStageSignature = "";
    }
    if (!stage && lastStage && ["COMPLETED", "FAILED", "CANCELLED"].includes(value.status)) {
      const terminalState =
        value.status === "CANCELLED" || value.outcome === "rejected"
          ? "cancelled"
          : value.outcome === "engineering_failure" ||
              value.outcome === "hard_stop" ||
              value.status === "FAILED"
            ? "failed"
            : "completed";
      await emitTelemetry?.(completeStageActivity(lastStage, terminalState, observedAt));
      lastStage = null;
      lastStageSignature = "";
    } else if (stage) {
      const signature = JSON.stringify({ ...stage, observed_at: null });
      if (signature !== lastStageSignature) {
        await emitTelemetry?.(stage);
        lastStageSignature = signature;
      }
      lastStage = stage;
    }
    for (const approval of workflowApprovalActivities(value, observedAt)) {
      const signature = JSON.stringify({
        state: approval.approval_state,
        decision: approval.decision ?? null,
        detail: approval.detail,
      });
      if (approvalStates.get(approval.request_id) === signature) continue;
      approvalStates.set(approval.request_id, signature);
      await emitTelemetry?.(approval);
    }
    const key = workflowTransitionKey(value);
    if (key !== lastStatus) {
      await emit({ ...value, compact_progress: true });
      lastStatus = key;
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(value.status)) return;
    if (value.current_task_status === "WAITING" && value.required_human_action) return;
    await new Promise<void>((done) => setTimeout(done, 3000));
  }
}
