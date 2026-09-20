import { describe, expect, it } from "vite-plus/test";
import {
  applicationDeliverySucceeded,
  formatWorkflowProgress,
  formatWorkflowStatus,
  workflowStatusKey,
  workflowTransitionKey,
} from "./owwWorkflowStatus.ts";
import type { WorkflowRecord } from "./owwWorkflow.ts";

const base: WorkflowRecord = {
  run_id: "12345678-1234-1234-1234-123456789abc",
  status: "RUNNING",
  project: "oww",
  original_task: "Add safe status",
  current_task: "validate",
  current_task_status: "RUNNING",
};

describe("OWW Hatchet status", () => {
  it("shows a compact actionable resource-scoped queue wait", () => {
    const rendered = formatWorkflowStatus({
      ...base,
      current_task: "deploy-uat-exact-sha",
      current_task_status: "QUEUED",
      waiting_reason: "waiting for UAT environment lock",
      waiting_resource: "UAT environment lock",
      resource_scope: "uat:zyncal",
      lock_owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      waiting_seconds: 134,
    });

    expect(rendered).toContain("UAT environment lock");
    expect(rendered).toContain("Resource  \nuat:zyncal");
    expect(rendered).toContain("Owner  \naaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(rendered).toContain("Waiting  \n02m 14s");
    expect(rendered).toContain("↻ **Refresh**");
    expect(rendered).toContain("show workflow status");
  });

  it("renders milestone progress and a live terminal snapshot", () => {
    const text = formatWorkflowProgress({
      ...base,
      current_task: "develop",
      current_task_status: "RUNNING",
      executor_provider: "codex",
      executor_model: "gpt-5.6-sol",
      executor_reasoning_effort: "high",
      stage_elapsed_seconds: 78,
      command_events: [
        {
          entry_kind: "command",
          command_id: "cmd-tests",
          stage: "develop",
          display_command: "dotnet test oww.Tests/Oww.Tests.csproj",
          command_state: "started",
          started_at: "2026-01-01T00:00:00Z",
          stdout_excerpt: "Running BookingEvidenceCollectorTests...",
        },
      ],
    });

    expect(text).toContain("% ");
    expect(text).toContain("▶ Live terminal");
    expect(text).toContain("Codex / gpt-5.6-sol • high reasoning");
    expect(text).toContain("$ dotnet test oww.Tests/Oww.Tests.csproj");
    expect(text).toContain("Running BookingEvidenceCollectorTests...");
    expect(text).toContain("01m 18s");
  });

  it("does not show a prior-stage command as the live development terminal", () => {
    const text = formatWorkflowProgress({
      ...base,
      current_task: "develop",
      current_task_status: "RUNNING",
      executor_provider: "devin",
      executor_model: "swe-2-high",
      command_events: [
        {
          entry_kind: "command",
          command_id: "plan-codex",
          stage: "plan",
          display_command: "codex executor --model gpt-5.6-sol --role planner [prompt omitted]",
          command_state: "completed",
          started_at: "2026-01-01T00:00:00Z",
          finished_at: "2026-01-01T00:00:10Z",
        },
        {
          entry_kind: "command",
          command_id: "develop-devin",
          stage: "develop",
          display_command: "devin executor --model swe-2-high --role developer [prompt omitted]",
          command_state: "started",
          started_at: "2026-01-01T00:01:00Z",
        },
      ],
    });

    expect(text).toContain("$ devin executor --model swe-2-high --role developer [prompt omitted]");
    expect(text).not.toContain(
      "$ codex executor --model gpt-5.6-sol --role planner [prompt omitted]",
    );
  });

  it("renders Hatchet-native fields without reconstructing a legacy state", () => {
    const text = formatWorkflowStatus({
      ...base,
      candidate_sha: "a".repeat(40),
      pr_url: "https://github.com/baykalmehmet/oww/pull/1",
      github_check_summary: "2 passed",
      merged_sha: "b".repeat(40),
      uat_status: "ready",
      deployed_sha: "b".repeat(40),
    });
    expect(text).toContain(`Hatchet run: ${base.run_id}`);
    expect(text).toContain("Current task: Validation  \nTask status: RUNNING");
    expect(text).toContain("Candidate: aaaaaaaaaaaa");
    expect(text).toContain("GitHub checks: 2 passed");
    expect(text).toContain("Deployment: bbbbbbbbbbbb");
  });

  it("renders bounded Validation repair evidence without dumping diagnostics", () => {
    const text = formatWorkflowProgress({
      ...base,
      status: "COMPLETED",
      outcome: "engineering_failure",
      stopped_at: "validate",
      current_task: null,
      current_task_status: null,
      candidate_sha: "b".repeat(40),
      current_activity: "Validation stopped: Backend unit tests failed",
      failure_classification: "DETERMINISTIC_VALIDATION_FAILED",
      validation_failed_check: "Backend unit tests",
      validation_failed_kind: "test",
      validation_exit_code: 1,
      validation_failure_fingerprint: `BACKEND_UNIT_TESTS:${"a".repeat(64)}`,
      validation_command: "dotnet test oww.Tests/Oww.Tests.csproj --configuration Release --nologo",
      validation_duration_ms: 6672,
      validation_stdout_excerpt: "Failed to restore Microsoft.EntityFrameworkCore.InMemory.10.0.10",
      validation_stderr_excerpt: "Read-only file system: [host path]",
      validation_repair_count: 2,
      validation_repair_limit: 2,
      summary: "Deterministic validation remained failing after bounded repairs",
    });

    expect(text).toContain("Validation stopped: Backend unit tests failed");
    expect(text).toContain("❌ Failed check  \nBackend unit tests");
    expect(text).toContain("Exit code  \n1");
    expect(text).toContain("🔁 Repairs  \n2/2");
    expect(text).toContain(`BACKEND_UNIT_TESTS:${"a".repeat(64)}`);
    expect(text).toContain(
      "Command  \ndotnet test oww.Tests/Oww.Tests.csproj --configuration Release --nologo",
    );
    expect(text).toContain("Duration  \n6672 ms");
    expect(text).toContain(
      "Stdout\n\n```text\nFailed to restore Microsoft.EntityFrameworkCore.InMemory.10.0.10\n```",
    );
    expect(text).toContain("Stderr\n\n```text\nRead-only file system: [host path]\n```");
    expect(text).not.toContain("Expected 2 Actual 3");
  });

  it("highlights explicit recovery options after a failed workflow", () => {
    const text = formatWorkflowProgress({
      ...base,
      status: "COMPLETED",
      outcome: "engineering_failure",
      candidate_sha: "c".repeat(40),
      review_findings: [
        { severity: "security", file: "oww/Auth.cs", line: 4, message: "Fix authorization" },
      ],
      summary: "Engineering review failed; candidate preserved for remediation",
    });

    expect(text).toContain("🛠 Recovery options");
    expect(text).toContain("**Repair:** `repair: <instructions>`");
    expect(text).toContain("**Inspect:** `show workflow status`");
    expect(text).toContain("**Stop:** take no action");
  });

  it("renders Repair 1/2 and Repair 2/2 authoritative current activity", () => {
    expect(
      formatWorkflowProgress({
        ...base,
        current_task: "develop",
        current_activity: "Repair 1/2: Backend unit tests",
      }),
    ).toContain("Repair 1/2: Backend unit tests");
    expect(
      formatWorkflowProgress({
        ...base,
        current_task: "develop",
        current_activity: "Repair 2/2: Backend unit tests",
      }),
    ).toContain("Repair 2/2: Backend unit tests");
  });

  it("does not render secret-shaped validation output", () => {
    const text = formatWorkflowProgress({
      ...base,
      status: "COMPLETED",
      outcome: "engineering_failure",
      validation_failed_check: "Backend unit tests",
      validation_stdout_excerpt: "access_token=do-not-display",
      validation_stderr_excerpt: "Authorization: Bearer do-not-display",
    });

    expect(text).not.toContain("do-not-display");
    expect(text).not.toContain("Stdout");
    expect(text).not.toContain("Stderr");
  });

  it("shows a durable wait and required human action", () => {
    const text = formatWorkflowStatus({
      ...base,
      current_task: "application-change",
      current_task_status: "WAITING",
      waiting_reason: "Hatchet durable event wait",
      required_human_action: "candidate decision for the exact SHA",
    });
    expect(text).toContain("Task status: WAITING");
    expect(text).toContain("👤 Required action  \ncandidate decision for the exact SHA");
  });

  it("deduplicates unchanged projections and suppresses secret-shaped progress", () => {
    expect(workflowStatusKey(base)).toBe(workflowStatusKey({ ...base }));
    expect(workflowStatusKey(base)).not.toBe(workflowStatusKey({ ...base, status: "COMPLETED" }));
    expect(
      formatWorkflowStatus({ ...base, latest_safe_progress_message: "token=unsafe" }),
    ).not.toContain("token=unsafe");
  });

  it("renders compact mobile progress with the actual executor route", () => {
    const text = formatWorkflowProgress({
      ...base,
      current_task: "develop",
      executor_provider: "devin",
      executor_model: "swe-2-high",
      current_activity: "Running targeted frontend tests",
      recent_actions: [
        { message: "Located UAT label component", state: "completed" },
        { message: "Updated ClientApp/oww-web/src/app/UatLabel.tsx", state: "completed" },
        { message: "Running targeted frontend tests", state: "current" },
      ],
    });
    expect(text).toBe(
      [
        "🛠 Development • RUNNING  ",
        "Devin / swe-2-high",
        "━━━░░░░░░░░░░░░░░░ 15%  ",
        "",
        "🎯 Current  ",
        "Running targeted frontend tests",
        "",
        "📍 Recent activity",
        "",
        "- ✅ Located UAT label component",
        "- ✏️ Updated ClientApp/oww-web/src/app/UatLabel.tsx",
        "- ▶️ Running targeted frontend tests",
        "",
        "↻ **Refresh** · send `show workflow status` for the latest authoritative state",
      ].join("\n"),
    );
  });

  it("keeps only the latest eight unique activity milestones in chronological order", () => {
    const recent_actions: NonNullable<WorkflowRecord["recent_actions"]> = Array.from(
      { length: 9 },
      (_, index) => ({
        message: `Milestone ${index + 1}`,
        state: "completed" as const,
      }),
    );
    recent_actions.push({ message: "Milestone 9", state: "current" });
    const text = formatWorkflowProgress({ ...base, recent_actions });
    expect(text).not.toContain("Milestone 1");
    expect(text.match(/Milestone 9/g)).toHaveLength(1);
    expect(text.indexOf("Milestone 2")).toBeLessThan(text.indexOf("Milestone 9"));
  });

  it("discards sensitive, host-path and private-reasoning activity", () => {
    const text = formatWorkflowProgress({
      ...base,
      current_activity: "Reading API token abc",
      recent_actions: [
        { message: "My reasoning: change the component", state: "current" },
        { message: "Editing /etc/platform/config", state: "completed" },
        { message: "Updated docs/hatchet.md", state: "completed" },
      ],
    });
    expect(text).not.toMatch(/token|reasoning|\/etc/);
    expect(text).toContain("Updated docs/hatchet.md");
  });

  it.each([
    ["plan", "Planning"],
    ["validate", "Validation"],
    ["review", "Review"],
    ["publish-pull-request", "Publishing"],
    ["github-check-status", "CI"],
    ["merge-exact-candidate", "Merge"],
    ["inspect-uat", "UAT Inspection"],
    ["prepare-uat-backup", "UAT Backup"],
    ["deploy-uat-exact-sha", "UAT Deployment"],
    ["verify-uat", "UAT Verification"],
  ])("uses a user-friendly stage name for %s", (task, label) => {
    expect(formatWorkflowProgress({ ...base, current_task: task })).toContain(`${label} • RUNNING`);
  });

  it("keeps explicit status authoritative while monitoring is compact", () => {
    const activity = {
      ...base,
      current_task: "review",
      current_activity: "Reviewing exact candidate",
      compact_progress: true,
    };
    expect(formatWorkflowStatus(activity)).toMatch(/^🔍 Review • RUNNING/);
    expect(formatWorkflowStatus({ ...activity, compact_progress: false })).toContain(
      `Hatchet run: ${base.run_id}`,
    );
  });

  it("renders completed engineering failure as stopped, never success", () => {
    const text = formatWorkflowStatus({
      ...base,
      status: "COMPLETED",
      work_kind: "application_change",
      outcome: "engineering_failure",
      summary: "The planner incorrectly marked the request non-actionable.",
      stopped_at: "plan",
      current_task: null,
      current_task_status: null,
    });
    expect(text).toContain("Execution: COMPLETED");
    expect(text).toContain("Outcome: engineering_failure");
    expect(text).toContain("Application state: FAILED / STOPPED");
    expect(text).toContain("Stopped at: Planning");
    expect(text).toContain("Reason: The planner incorrectly marked the request non-actionable.");
    expect(text).toContain("Candidate: none");
    expect(text).toContain("PR: none");
    expect(text).toContain("Deployment: not reached");
    expect(text).not.toContain("SUCCESS / COMPLETE");
  });

  it("renders a completed hard stop as blocked", () => {
    const text = formatWorkflowStatus({
      ...base,
      status: "COMPLETED",
      work_kind: "application_change",
      outcome: "hard_stop",
      summary: "UAT controller incompatible.",
      required_human_action: "Upgrade the restricted controller.",
    });
    expect(text).toContain("Application state: BLOCKED / HARD STOP");
    expect(text).toContain("👤 Required action  \nUpgrade the restricted controller.");
  });

  it("requires complete and matching release evidence for application success", () => {
    const complete = {
      ...base,
      status: "COMPLETED",
      work_kind: "application_change" as const,
      outcome: "complete" as const,
      candidate_sha: "a".repeat(40),
      pr_url: "https://github.com/baykalmehmet/oww/pull/123",
      merged_sha: "b".repeat(40),
      deployed_sha: "b".repeat(40),
    };
    expect(applicationDeliverySucceeded(complete)).toBe(true);
    expect(formatWorkflowStatus(complete)).toContain("Application state: SUCCESS / COMPLETE");

    const missingDeployment = { ...complete, deployed_sha: null };
    expect(applicationDeliverySucceeded(missingDeployment)).toBe(false);
    expect(formatWorkflowStatus(missingDeployment)).toContain(
      "Application state: FAILED / INCOMPLETE RELEASE EVIDENCE",
    );

    const wrongDeployment = { ...complete, deployed_sha: "c".repeat(40) };
    expect(applicationDeliverySucceeded(wrongDeployment)).toBe(false);
    expect(formatWorkflowStatus(wrongDeployment)).not.toContain(
      "Application state: SUCCESS / COMPLETE",
    );
  });

  it("renders eight recent actions as eight distinct physical lines", () => {
    const recent_actions = Array.from({ length: 8 }, (_, index) => ({
      message: `Action ${index + 1}`,
      state: index === 7 ? ("current" as const) : ("completed" as const),
    }));
    const lines = formatWorkflowProgress({ ...base, recent_actions }).split("\n");
    const start = lines.indexOf("📍 Recent activity");
    const activityLines = lines.slice(start + 2, start + 10);
    const marker = /^- (?:✅|▶️|⚠️|⬆️|✏️|❌|⏳)/u;

    expect(activityLines).toHaveLength(8);
    expect(activityLines.every((entry) => marker.test(entry))).toBe(true);
    expect(
      activityLines.every(
        (entry) => (entry.match(/(?:✅|▶️|⚠️|⬆️|✏️|❌|⏳)/gu) ?? []).length === 1,
      ),
    ).toBe(true);
    expect(activityLines.join("\n")).not.toContain(", Action");
    expect(activityLines.join("\n")).not.toContain(" | ");
  });

  it("puts Current and Next headings and values on separate physical lines", () => {
    const lines = formatWorkflowProgress({
      ...base,
      current_activity: "Running tests",
      next_action: "Candidate measurement",
    }).split("\n");
    expect(lines[lines.indexOf("🎯 Current  ") + 1]).toBe("Running tests");
    expect(lines[lines.indexOf("⏭ Next  ") + 1]).toBe("Candidate measurement");
    expect(lines).not.toContain("🎯 Current Running tests");
    expect(lines).not.toContain("⏭ Next Candidate measurement");
  });

  it("renders validation checks, CI checks and evidence one item per line", () => {
    const validation = formatWorkflowProgress({
      ...base,
      safe_files: ["ClientApp/src/UatLabel.tsx", "ClientApp/tests/UatLabel.test.tsx"],
      checks: [
        { name: "Build", state: "passed" },
        { name: "TypeScript", state: "passed" },
        { name: "Integration tests", state: "running" },
      ],
      evidence: [
        { message: "Correct branch", state: "passed" },
        { message: "Candidate SHA not produced", state: "failed" },
      ],
    }).split("\n");
    expect(validation).not.toContain("📁 Files");
    expect(
      validation.slice(validation.indexOf("🔎 Checks") + 2, validation.indexOf("🔎 Checks") + 5),
    ).toEqual(["- ✅ Build", "- ✅ TypeScript", "- ▶️ Integration tests"]);
    expect(
      validation.slice(
        validation.indexOf("🔎 Evidence") + 2,
        validation.indexOf("🔎 Evidence") + 4,
      ),
    ).toEqual(["- ✅ Correct branch", "- ❌ Candidate SHA not produced"]);

    const ci = formatWorkflowProgress({
      ...base,
      current_task: "github-check-status",
      checks: [
        { name: "npm audit", state: "passed" },
        { name: "NuGet vulnerability audit", state: "pending" },
      ],
    }).split("\n");
    expect(ci.slice(ci.indexOf("🔎 Checks") + 2, ci.indexOf("🔎 Checks") + 4)).toEqual([
      "- ✅ npm audit",
      "- ⏳ NuGet vulnerability audit",
    ]);
  });

  it("renders each Development attempt on its own physical line", () => {
    const text = formatWorkflowProgress({
      ...base,
      status: "COMPLETED",
      current_task: null,
      current_task_status: null,
      stopped_at: "develop",
      work_kind: "application_change",
      outcome: "engineering_failure",
      failure_classification: "NO_CANDIDATE_CHANGE",
      development_attempts: [
        {
          attempt_number: 1,
          attempt_limit: 3,
          role: "implementation",
          profile: "economical_coding",
          provider: "devin",
          model: "swe-2-high",
          result_classification: "NO_CANDIDATE_CHANGE",
          escalation: false,
        },
        {
          attempt_number: 2,
          attempt_limit: 3,
          role: "implementation",
          profile: "economical_coding",
          provider: "devin",
          model: "swe-2-high",
          result_classification: "NO_CANDIDATE_CHANGE",
          escalation: false,
        },
        {
          attempt_number: 3,
          attempt_limit: 3,
          role: "coding_escalation",
          profile: "strong_coding",
          provider: "codex",
          model: "gpt-5.3-codex",
          result_classification: "NO_CANDIDATE_CHANGE",
          escalation: true,
        },
      ],
    });
    const lines = text.split("\n");
    const start = lines.indexOf("🔁 Attempts");
    expect(lines.slice(start + 2, start + 5)).toEqual([
      "- 1. Devin / swe-2-high (economical_coding) → no candidate change",
      "- 2. Devin / swe-2-high (economical_coding) → no candidate change",
      "- 3. Codex / gpt-5.3-codex (strong_coding) → no candidate change",
    ]);
  });

  it("retains only the latest eight actions without relying on Markdown wrapping", () => {
    const recent_actions = Array.from({ length: 9 }, (_, index) => ({
      message: `Event ${index + 1}`,
      state: "completed" as const,
    }));
    const text = formatWorkflowProgress({ ...base, recent_actions });
    const lines = text.split("\n");
    const start = lines.indexOf("📍 Recent activity");
    const rendered = lines.slice(start + 2, start + 10);
    expect(rendered).toHaveLength(8);
    expect(rendered[0]).toBe("- ✅ Event 2");
    expect(rendered[7]).toBe("- ✅ Event 9");
    expect(text).not.toContain("Event 1\n");
  });

  it("formats Planning with actual route, elapsed time and explicit next action", () => {
    const text = formatWorkflowProgress({
      ...base,
      current_task: "plan",
      executor_provider: "codex",
      executor_model: "gpt-5.6-sol",
      executor_reasoning_effort: "high",
      stage_elapsed_seconds: 134,
      current_activity: "Building implementation plan",
      next_action: "Development",
    });
    expect(text).toContain(
      "🧠 Planning • RUNNING  \nCodex / gpt-5.6-sol • high reasoning • 02m 14s",
    );
    expect(text).toContain("🎯 Current  \nBuilding implementation plan");
    expect(text).toContain("⏭ Next  \nDevelopment");
  });

  it("formats normal, retrying and escalated Development from structured attempts", () => {
    const normal = formatWorkflowProgress({
      ...base,
      current_task: "develop",
      executor_provider: "devin",
      executor_model: "swe-2-high",
      attempt_number: 1,
      attempt_limit: 3,
      current_activity: "Updating the UAT deployment-details popup",
    });
    expect(normal).toContain("🛠 Development • RUNNING  \nDevin / swe-2-high • Attempt 1/3");

    const prior = {
      attempt_number: 1,
      attempt_limit: 3,
      role: "implementation",
      profile: "economical_coding",
      provider: "devin" as const,
      model: "swe-2-high",
      result_classification: "NO_CANDIDATE_CHANGE",
      escalation: false,
    };
    const retry = formatWorkflowProgress({
      ...base,
      current_task: "develop",
      executor_provider: "devin",
      executor_model: "swe-2-high",
      attempt_number: 2,
      attempt_limit: 3,
      development_attempts: [prior],
    });
    expect(retry).toContain("🔁 Development • RETRYING");
    expect(retry).toContain("⚠️ Previous attempt  \nNO_CANDIDATE_CHANGE");

    const escalated = formatWorkflowProgress({
      ...base,
      current_task: "develop",
      executor_provider: "codex",
      executor_model: "gpt-5.3-codex",
      executor_reasoning_effort: "high",
      attempt_number: 3,
      attempt_limit: 3,
      attempt_escalation: true,
      development_attempts: [prior, { ...prior, attempt_number: 2 }],
    });
    expect(escalated).toContain("⬆️ Development • ESCALATED");
    expect(escalated).toContain("Codex / gpt-5.3-codex • high reasoning • Attempt 3/3");
    expect(escalated).toContain(
      "⚡ Escalation reason  \nEconomical implementation attempts produced no candidate",
    );
  });

  it("formats Validation, Review, Approval, Publishing, CI and Merge", () => {
    expect(
      formatWorkflowProgress({
        ...base,
        current_task: "validate",
        checks: [
          { name: "Build", state: "passed" },
          { name: "Tests", state: "running" },
        ],
      }),
    ).toContain("🧪 Validation • RUNNING  \nDeterministic checks • 1/2 complete");
    expect(
      formatWorkflowProgress({
        ...base,
        current_task: "review",
        executor_provider: "devin",
        executor_model: "swe-2-high",
      }),
    ).toContain("🔍 Review • RUNNING  \nDevin / swe-2-high");
    expect(
      formatWorkflowProgress({
        ...base,
        current_task: "application-change",
        current_task_status: "WAITING",
        waiting_reason: "candidate approval for the exact candidate SHA",
        candidate_sha: "a".repeat(40),
        required_human_action: "Approve candidate to continue",
      }),
    ).toContain("🟡 Approval Required");
    expect(formatWorkflowProgress({ ...base, current_task: "publish-pull-request" })).toContain(
      "📤 Publishing • RUNNING",
    );
    expect(formatWorkflowProgress({ ...base, current_task: "github-check-status" })).toContain(
      "🔄 CI • RUNNING",
    );
    expect(formatWorkflowProgress({ ...base, current_task: "merge-exact-candidate" })).toContain(
      "🔀 Merge • RUNNING",
    );
  });

  it("formats Migration, Backup, UAT deployment and UAT verification", () => {
    expect(
      formatWorkflowProgress({
        ...base,
        current_task: "application-change",
        current_task_status: "WAITING",
        waiting_reason: "migration approval for the exact merged SHA",
      }),
    ).toContain("🗃 Migration Approval • WAITING");
    expect(formatWorkflowProgress({ ...base, current_task: "prepare-uat-backup" })).toContain(
      "💾 UAT Backup • RUNNING",
    );
    expect(
      formatWorkflowProgress({
        ...base,
        current_task: "deploy-uat-exact-sha",
        merged_sha: "b".repeat(40),
      }),
    ).toContain("🚢 UAT Deployment • RUNNING");
    expect(
      formatWorkflowProgress({
        ...base,
        current_task: "verify-uat",
        deployed_sha: "b".repeat(40),
        checks: [
          { name: "API readiness", state: "passed" },
          { name: "Web health", state: "running" },
        ],
      }),
    ).toContain("🩺 UAT Verification • RUNNING");
  });

  it("does not generate monitoring updates for elapsed time alone", () => {
    expect(workflowStatusKey({ ...base, stage_elapsed_seconds: 10 })).toBe(
      workflowStatusKey({ ...base, stage_elapsed_seconds: 20 }),
    );
    expect(workflowStatusKey({ ...base, current_activity: "Running tests" })).not.toBe(
      workflowStatusKey({ ...base, current_activity: "Reviewing results" }),
    );
    expect(workflowStatusKey({ ...base, attempt_number: 1 })).not.toBe(
      workflowStatusKey({ ...base, attempt_number: 2 }),
    );
  });

  it("refreshes Markdown summaries once a minute while native tasks carry live detail", () => {
    expect(workflowTransitionKey({ ...base, current_activity: "Running tests" })).not.toBe(
      workflowTransitionKey({ ...base, current_activity: "Reviewing results" }),
    );
    expect(workflowTransitionKey({ ...base, stage_elapsed_seconds: 10 })).toBe(
      workflowTransitionKey({ ...base, stage_elapsed_seconds: 59 }),
    );
    expect(workflowTransitionKey({ ...base, stage_elapsed_seconds: 59 })).not.toBe(
      workflowTransitionKey({ ...base, stage_elapsed_seconds: 60 }),
    );
    expect(workflowTransitionKey({ ...base, current_task: "develop" })).not.toBe(
      workflowTransitionKey({ ...base, current_task: "validate" }),
    );
  });

  it("omits unsafe file, evidence and check entries", () => {
    const text = formatWorkflowProgress({
      ...base,
      safe_files: ["docs/safe.md", "/etc/private.conf", "../outside", ".env"],
      checks: [
        { name: "Authorization header abc", state: "failed" },
        { name: "Build", state: "passed" },
      ],
      evidence: [
        { message: "API token abc", state: "failed" },
        { message: "Branch verified", state: "passed" },
      ],
    });
    expect(text).not.toContain("docs/safe.md");
    expect(text).toContain("- ✅ Build");
    expect(text).toContain("- ✅ Branch verified");
    expect(text).not.toMatch(/\/etc|\.env|outside|Authorization header|API token/);
  });

  it("does not duplicate native command or file rows in Recent activity", () => {
    const text = formatWorkflowProgress({
      ...base,
      recent_actions: [
        { message: "Planning complete", state: "completed", entry_kind: "activity" },
        { message: "git diff --check", state: "completed", entry_kind: "command" },
        {
          message: "Updated ClientApp/src/config.ts",
          state: "completed",
          entry_kind: "file",
          file_operation: "update",
          file_path: "ClientApp/src/config.ts",
        },
      ],
    });
    expect(text).toContain("Planning complete");
    expect(text).not.toContain("git diff --check");
    expect(text).not.toContain("Updated ClientApp/src/config.ts");
  });

  it("renders a safe PR navigation link and rejects unsafe link schemes", () => {
    expect(
      formatWorkflowProgress({
        ...base,
        pr_number: 97,
        pr_url: "https://github.com/baykalmehmet/oww/pull/97",
      }),
    ).toContain("[PR #97](https://github.com/baykalmehmet/oww/pull/97)");
    expect(
      formatWorkflowProgress({ ...base, pr_number: 97, pr_url: "javascript:alert(1)" }),
    ).not.toContain("javascript:");
  });

  it("uses CommonMark block lists and hard breaks required by the T3 mobile renderer", () => {
    const text = formatWorkflowProgress({
      ...base,
      current_activity: "Running tests",
      recent_actions: [
        { message: "Plan received", state: "completed" },
        { message: "Running tests", state: "current" },
      ],
      next_action: "Candidate measurement",
    });
    expect(text).toContain("🎯 Current  \nRunning tests");
    expect(text).toContain("📍 Recent activity\n\n- ✅ Plan received\n- ▶️ Running tests");
    expect(text).toContain("⏭ Next  \nCandidate measurement");
    expect(text).not.toContain("🎯 Current\nRunning tests");
    expect(text).not.toContain("📍 Recent activity\n✅");
  });

  it("renders the escalated Development console as distinct CommonMark blocks", () => {
    const prior = {
      attempt_number: 1,
      attempt_limit: 3,
      role: "implementation",
      profile: "economical_coding",
      provider: "devin" as const,
      model: "swe-2-high",
      result_classification: "NO_CANDIDATE_CHANGE",
      escalation: false,
    };
    const text = formatWorkflowProgress({
      ...base,
      current_task: "develop",
      executor_provider: "codex",
      executor_model: "gpt-5.3-codex",
      executor_reasoning_effort: "high",
      attempt_number: 3,
      attempt_limit: 3,
      attempt_escalation: true,
      development_attempts: [prior, { ...prior, attempt_number: 2 }],
      current_activity: "Escalating implementation to strong_coding",
      recent_actions: [
        { message: "Plan received", state: "completed" },
        { message: "Discovering relevant files", state: "completed" },
        { message: "First implementation produced no candidate", state: "warning" },
        { message: "Implementing requested behavior", state: "completed" },
        { message: "Economical implementation produced no candidate", state: "warning" },
        { message: "Retrying bounded implementation", state: "completed" },
        { message: "Bounded economical attempts exhausted", state: "completed" },
        { message: "Escalating implementation to strong_coding", state: "current" },
      ],
      evidence: [
        { message: "No forbidden files detected", state: "passed" },
        { message: "HEAD remained equal to base SHA", state: "failed" },
        { message: "Candidate SHA not produced", state: "failed" },
        { message: "Correct worktree and branch identity", state: "passed" },
        { message: "Base ancestry valid", state: "passed" },
        { message: "Worktree clean", state: "passed" },
      ],
      next_action: "Measure candidate → deterministic Validation",
    });

    expect(text).toBe(
      [
        "⬆️ Development • ESCALATED  ",
        "Codex / gpt-5.3-codex • high reasoning • Attempt 3/3",
        "━━━░░░░░░░░░░░░░░░ 15%  ",
        "",
        "⚠️ Previous attempt  ",
        "NO_CANDIDATE_CHANGE",
        "",
        "⚡ Escalation reason  ",
        "Economical implementation attempts produced no candidate",
        "",
        "🎯 Current  ",
        "Escalating implementation to strong_coding",
        "",
        "📍 Recent activity",
        "",
        "- ✅ Plan received",
        "- ✅ Discovering relevant files",
        "- ⚠️ First implementation produced no candidate",
        "- ✅ Implementing requested behavior",
        "- ⚠️ Economical implementation produced no candidate",
        "- 🔁 Retrying bounded implementation",
        "- ✅ Bounded economical attempts exhausted",
        "- ▶️ Escalating implementation to strong_coding",
        "",
        "🔎 Evidence",
        "",
        "- ✅ No forbidden files detected",
        "- ❌ HEAD remained equal to base SHA",
        "- ❌ Candidate SHA not produced",
        "- ✅ Correct worktree and branch identity",
        "- ✅ Base ancestry valid",
        "- ✅ Worktree clean",
        "",
        "⏭ Next  ",
        "Measure candidate → deterministic Validation",
        "",
        "↻ **Refresh** · send `show workflow status` for the latest authoritative state",
      ].join("\n"),
    );
  });

  it("shows interrupted executor evidence and the correct escalation reason", () => {
    const interrupted = {
      attempt_number: 1,
      attempt_limit: 3,
      role: "implementation",
      profile: "economical_coding",
      provider: "devin" as const,
      model: "swe-2-high",
      result_classification: "EXECUTOR_FAILED",
      escalation: false,
      executor_exit_code: -15,
    };
    const text = formatWorkflowProgress({
      ...base,
      current_task: "develop",
      current_task_status: "RUNNING",
      attempt_number: 2,
      attempt_limit: 3,
      attempt_escalation: true,
      development_attempts: [interrupted],
      current_activity: "Escalating after executor interruption",
    });

    expect(text).toContain(
      "⚡ Escalation reason  \nPrior implementation executor failed or was interrupted",
    );

    const terminal = formatWorkflowProgress({
      ...base,
      status: "COMPLETED",
      outcome: "engineering_failure",
      current_task: "develop",
      current_task_status: "FAILED",
      development_attempts: [interrupted],
    });
    expect(terminal).toContain("executor failed (exit -15)");
  });

  it("shows complete recovery prompts for a terminal validation failure", () => {
    const text = formatWorkflowProgress({
      ...base,
      status: "COMPLETED",
      outcome: "attention_required",
      current_task: "validate",
      failure_classification: "BACKEND_UNIT_TESTS",
      validation_failed_check: "AvailabilityServiceTests.ShouldRejectOverlap",
      validation_command: "dotnet test oww.Tests/Oww.Tests.csproj --configuration Release",
      validation_exit_code: 1,
      validation_failure_fingerprint: "BACKEND_UNIT_TESTS:4ab99",
      validation_stderr_excerpt: "Expected false but was true",
      candidate_sha: "a".repeat(40),
    });

    expect(text).toContain("🛠 Recovery prompts");
    expect(text).toContain("A. Fix with focused repair");
    expect(text).toContain("B. Diagnose without changing files");
    expect(text).toContain("C. Escalate repair strategy");
    expect(text).toContain("AvailabilityServiceTests.ShouldRejectOverlap");
    expect(text).not.toContain("/run/credentials");
  });
});
