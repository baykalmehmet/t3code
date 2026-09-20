// @effect-diagnostics nodeBuiltinImport:off - Test source-patch assertions read text directly.
import { describe, expect, it, vi } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { EventId, TurnId } from "@t3tools/contracts";
import {
  approvalActivityToNative,
  commandActivityToNative,
  completeStageActivity,
  createOwwApprovalResolutionGuard,
  fileActivityToNative,
  monitorOwwWorkflow,
  stageActivityToNative,
  workflowApprovalActivities,
  workflowStageActivity,
  type CommandActivity,
  type StageActivity,
  type WorkflowCall,
  type WorkflowRecord,
  type WorkflowTelemetry,
} from "./owwWorkflow.ts";

const runId = "12345678-1234-1234-1234-123456789abc";
const base: WorkflowRecord = { run_id: runId, status: "RUNNING", project: "oww" };
const started: CommandActivity = {
  message: "Running platform command",
  state: "current",
  entry_kind: "command",
  command_id: "develop:abc",
  stage: "develop",
  attempt_number: 1,
  executor_provider: "devin",
  executor_model: "swe-2-high",
  display_command: "npm run build",
  command_state: "started",
  started_at: "2026-09-17T12:00:00.000Z",
};

type NativePayload = {
  itemType: string;
  toolCallId: string;
  status: string;
  data: {
    stage: string;
    attemptNumber: number | null;
    durationMs: number | null;
    exitCode: number | null;
    timedOut: boolean;
    rawOutput: { stdout?: string; stderr?: string };
  };
};

describe("OWW native T3 telemetry", () => {
  it("keeps the synthetic workflow turn live for the full monitor lifecycle", async () => {
    const reactor = await readFile(
      new URL("./Layers/ProviderCommandReactor.ts", import.meta.url),
      "utf8",
    );
    expect(reactor).toContain('status: "running"');
    expect(reactor).toContain("activeTurnId: workflowTurnId");
    expect(reactor).toContain(
      "Effect.ensuring(stopWorkflowSession().pipe(Effect.ignoreCause({ log: true })))",
    );
    expect(reactor).toContain("current?.session?.activeTurnId !== workflowTurnId");
  });

  it("coalesces replayed Hatchet approval commands without a false failure", async () => {
    const reactor = await readFile(
      new URL("./Layers/ProviderCommandReactor.ts", import.meta.url),
      "utf8",
    );
    expect(reactor).toContain("if (!owwApprovalGuard.begin(requestId))");
    expect(reactor).toContain("same durable request must not call Hatchet again");
    expect(reactor).not.toContain("This action was already resolved.");
  });

  it("maps started and completed lifecycle updates onto one native command ID", () => {
    const turnId = TurnId.make("oww-workflow:message-1");
    const running = commandActivityToNative(started, EventId.make("event-start"), turnId);
    const completed = commandActivityToNative(
      {
        ...started,
        state: "completed",
        command_state: "completed",
        finished_at: "2026-09-17T12:00:03.250Z",
        duration_ms: 3250,
        exit_code: 0,
        stdout_excerpt: "build passed",
        stderr_excerpt: "warning",
      },
      EventId.make("event-complete"),
      turnId,
    );
    const runningPayload = running.payload as NativePayload;
    const completedPayload = completed.payload as NativePayload;

    expect(running.kind).toBe("tool.updated");
    expect(runningPayload.status).toBe("inProgress");
    expect(completed.kind).toBe("tool.completed");
    expect(completedPayload.status).toBe("completed");
    expect(runningPayload.toolCallId).toBe(completedPayload.toolCallId);
    expect(running.turnId).toBe(turnId);
    expect(completed.turnId).toBe(turnId);
    expect(completedPayload.data).toEqual(
      expect.objectContaining({
        stage: "develop",
        attemptNumber: 1,
        durationMs: 3250,
        exitCode: 0,
        rawOutput: { stdout: "build passed", stderr: "warning" },
      }),
    );
  });

  it.each([
    ["failed", 7, false],
    ["timed_out", null, true],
  ] as const)("maps %s to native failed completion", (state, exitCode, timedOut) => {
    const native = commandActivityToNative(
      {
        ...started,
        state: "failed",
        command_state: state,
        finished_at: "2026-09-17T12:01:00.000Z",
        exit_code: exitCode,
      },
      EventId.make(`event-${state}`),
    );
    const payload = native.payload as NativePayload;
    expect(native.kind).toBe("tool.completed");
    expect(payload.status).toBe("failed");
    expect(payload.data.timedOut).toBe(timedOut);
  });

  it("keeps a resolved native approval closed if its request is replayed", () => {
    const value: WorkflowRecord = {
      ...base,
      current_task: "application-change",
      current_task_status: "WAITING",
      waiting_reason: "candidate approval for the exact candidate SHA",
      candidate_sha: "a".repeat(40),
    };
    const requested = workflowApprovalActivities(value, "2026-09-17T12:00:00.000Z")[0]!;
    const guard = createOwwApprovalResolutionGuard();
    expect(guard.begin(requested.request_id)).toBe(true);
    expect(guard.begin(requested.request_id)).toBe(false);
    guard.resolve(requested.request_id);
    expect(guard.begin(requested.request_id)).toBe(false);
    const resolved = approvalActivityToNative({
      ...requested,
      approval_state: "resolved",
      observed_at: "2026-09-17T12:00:01.000Z",
      decision: "accept",
    });
    expect((resolved.payload as Record<string, unknown>).requestId).toBe(requested.request_id);
  });

  it.each([
    ["read", "dynamic_tool_call", "file-read"],
    ["search", "web_search", undefined],
    ["update", "file_change", undefined],
    ["create", "file_change", undefined],
    ["delete", "file_change", undefined],
  ] as const)(
    "maps authoritative safe file %s activity through the native item type",
    (operation, itemType, requestKind) => {
      const native = fileActivityToNative(
        {
          message: `${operation} ClientApp/src/layout.tsx`,
          state: "completed",
          entry_kind: "file",
          file_operation: operation,
          file_path: "ClientApp/src/layout.tsx",
        },
        EventId.make(`file-${operation}`),
        "2026-09-17T12:00:00.000Z",
      );
      expect(native?.kind).toBe("tool.completed");
      expect(native?.payload).toEqual(
        expect.objectContaining({
          itemType,
          ...(requestKind ? { requestKind } : {}),
        }),
      );
    },
  );

  it("uses one stable native task identity from running through compact completion", () => {
    const value: WorkflowRecord = {
      ...base,
      current_task: "develop",
      current_task_status: "RUNNING",
      stage_started_at: "2026-09-17T12:00:00.000Z",
      stage_elapsed_seconds: 378,
      executor_provider: "devin",
      executor_model: "swe-2-high",
      attempt_number: 1,
      attempt_limit: 3,
      current_activity: "Editing deployed-version display",
      candidate_sha: "a".repeat(40),
      next_action: "Measure candidate → deterministic Validation",
    };
    const running = workflowStageActivity(value, "2026-09-17T12:06:18.000Z")!;
    const completed = completeStageActivity(running, "completed", "2026-09-17T12:06:19.000Z");
    const runningNative = stageActivityToNative(running, TurnId.make("workflow-turn"));
    const completedNative = stageActivityToNative(completed, TurnId.make("workflow-turn"));

    expect(running.task_id).toBe(`hatchet:${runId}:develop`);
    expect(runningNative.id).toBe(completedNative.id);
    expect(runningNative.kind).toBe("task.progress");
    expect(completedNative.kind).toBe("task.completed");
    expect(running.title).toContain("▶️ 🛠 Development · RUNNING · 06m 18s");
    expect((runningNative.payload as Record<string, unknown>).durationMs).toBe(378_000);
    expect(completed.detail).toBe("swe-2-high · Attempt 1/3 · Candidate aaaaaaaaaaaa");
    expect(completed.detail).not.toContain("Editing deployed-version display");
  });

  it("changes the active stable task only when Hatchet changes stage", () => {
    const develop = workflowStageActivity(
      { ...base, current_task: "develop", current_task_status: "RUNNING" },
      "2026-09-17T12:00:00.000Z",
    )!;
    const validate = workflowStageActivity(
      { ...base, current_task: "validate", current_task_status: "RUNNING" },
      "2026-09-17T12:01:00.000Z",
    )!;
    expect(develop.task_id).not.toBe(validate.task_id);
    expect(validate.title).toContain("🧪 Validation");
  });

  it("keeps terminal Validation failure evidence compact in the native stage task", () => {
    const failed = workflowStageActivity(
      {
        ...base,
        status: "COMPLETED",
        outcome: "engineering_failure",
        stopped_at: "validate",
        candidate_sha: "c".repeat(40),
        current_activity: "Validation stopped: Backend unit tests failed",
        validation_failed_check: "Backend unit tests",
        validation_exit_code: 1,
        validation_failure_fingerprint: `BACKEND_UNIT_TESTS:${"d".repeat(64)}`,
        validation_repair_count: 2,
        validation_repair_limit: 2,
        summary: "Deterministic validation remained failing after bounded repairs",
      },
      "2026-09-17T12:10:00.000Z",
    )!;

    expect(failed.stage_state).toBe("failed");
    expect(failed.detail).toContain("Failed check: Backend unit tests");
    expect(failed.detail).toContain("Exit code: 1");
    expect(failed.detail).toContain("Repairs: 2/2");
    expect(failed.detail).toContain("Failure fingerprint: BACKEND_UNIT_TESTS:dddd");
  });

  it("keeps a failed stage prominent with classification, reason and required action", () => {
    const failed = workflowStageActivity(
      {
        ...base,
        status: "COMPLETED",
        outcome: "engineering_failure",
        stopped_at: "review",
        failure_classification: "REVIEW_OUTPUT_INVALID",
        summary: "Reviewer returned invalid structured output.",
        required_human_action: "Retry Review",
      },
      "2026-09-17T12:00:00.000Z",
    )!;
    const native = stageActivityToNative(failed);
    expect(failed.title).toContain("🛑 🔍 Review · FAILED");
    expect(failed.detail).toContain("Classification: REVIEW_OUTPUT_INVALID");
    expect(failed.detail).toContain("Reason: Reviewer returned invalid structured output.");
    expect(failed.detail).toContain("Required action: Retry Review");
    expect(native.tone).toBe("error");
    expect(native.kind).toBe("task.completed");
  });

  it.each([
    ["candidate approval for the exact candidate SHA", "candidate", "Candidate approval required"],
    ["migration approval for the exact merged SHA", "migration", "Migration approval required"],
  ] as const)("emits native %s controls", (waitingReason, action, summary) => {
    const value: WorkflowRecord = {
      ...base,
      current_task: "application-change",
      current_task_status: "WAITING",
      waiting_reason: waitingReason,
      candidate_sha: "a".repeat(40),
      merged_sha: "b".repeat(40),
    };
    const approval = workflowApprovalActivities(value, "2026-09-17T12:00:00.000Z").find(
      (item) => item.action === action && item.approval_state === "requested",
    )!;
    const native = approvalActivityToNative(approval);
    const payload = native.payload as Record<string, unknown>;
    expect(native.kind).toBe("approval.requested");
    expect(native.summary).toBe(summary);
    expect(payload.options).toEqual([
      { decision: "accept", label: "Approve" },
      { decision: "decline", label: "Reject" },
    ]);
    expect(String(payload.requestId)).toContain(value.run_id);
  });

  it("emits retry only for one explicitly retryable failed task", () => {
    expect(
      workflowApprovalActivities({ ...base, status: "COMPLETED" }, "2026-09-17T12:00:00.000Z"),
    ).toEqual([]);
    const retry = workflowApprovalActivities(
      {
        ...base,
        status: "COMPLETED",
        retryable_task_id: "87654321-4321-4321-4321-cba987654321",
        retryable_task_name: "validate",
      },
      "2026-09-17T12:00:00.000Z",
    )[0]!;
    expect(retry.action).toBe("retry");
    expect((approvalActivityToNative(retry).payload as Record<string, unknown>).options).toEqual([
      { decision: "accept", label: "Retry failed stage" },
      { decision: "decline", label: "Dismiss" },
    ]);
  });

  it("deduplicates unchanged command snapshots while preserving status updates", async () => {
    vi.useFakeTimers();
    const heartbeat: CommandActivity = {
      ...started,
      duration_ms: 15_000,
    };
    const completed: CommandActivity = {
      ...started,
      state: "completed",
      command_state: "completed",
      finished_at: "2026-09-17T12:00:01.000Z",
      duration_ms: 1000,
      exit_code: 0,
    };
    const values: WorkflowRecord[] = [
      { ...base, command_events: [started] },
      { ...base, command_events: [started] },
      { ...base, command_events: [heartbeat] },
      { ...base, status: "COMPLETED", command_events: [completed] },
    ];
    let index = 0;
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async () => values[Math.min(index++, 3)]!);
    const emitStatus = vi.fn<(value: WorkflowRecord) => Promise<void>>(async () => undefined);
    const emitCommand = vi.fn<(activity: WorkflowTelemetry) => Promise<void>>(
      async () => undefined,
    );
    try {
      const monitoring = monitorOwwWorkflow(runId, emitStatus, call, emitCommand);
      await vi.runAllTimersAsync();
      await monitoring;
      const commands = emitCommand.mock.calls
        .map(([activity]) => activity)
        .filter((activity): activity is CommandActivity => activity.entry_kind === "command");
      expect(commands.map((activity) => activity.command_state)).toEqual([
        "started",
        "started",
        "completed",
      ]);
      expect(commands[1]?.duration_ms).toBe(15_000);
      expect(call).not.toHaveBeenCalledWith("start_task", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("upserts current stage detail, compacts the completed stage, and activates the next", async () => {
    vi.useFakeTimers();
    const values: WorkflowRecord[] = [
      {
        ...base,
        current_task: "develop",
        current_task_status: "RUNNING",
        current_activity: "Editing A",
        stage_elapsed_seconds: 10,
      },
      {
        ...base,
        current_task: "develop",
        current_task_status: "RUNNING",
        current_activity: "Testing A",
        stage_elapsed_seconds: 13,
      },
      {
        ...base,
        current_task: "validate",
        current_task_status: "RUNNING",
        current_activity: "Running checks",
        stage_elapsed_seconds: 1,
      },
      { ...base, status: "COMPLETED", outcome: "complete" },
    ];
    let index = 0;
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async () => values[Math.min(index++, 3)]!);
    const status = vi.fn<(value: WorkflowRecord) => Promise<void>>(async () => undefined);
    const telemetry = vi.fn<(activity: WorkflowTelemetry) => Promise<void>>(async () => undefined);
    try {
      const monitoring = monitorOwwWorkflow(runId, status, call, telemetry);
      await vi.runAllTimersAsync();
      await monitoring;
      const stages = telemetry.mock.calls
        .map(([activity]) => activity)
        .filter((activity): activity is StageActivity => activity.entry_kind === "stage");
      expect(
        stages.filter((stage) => stage.stage === "develop").map((stage) => stage.task_id),
      ).toEqual(
        Array(stages.filter((stage) => stage.stage === "develop").length).fill(
          `hatchet:${runId}:develop`,
        ),
      );
      expect(
        stages.some((stage) => stage.stage === "develop" && stage.stage_state === "completed"),
      ).toBe(true);
      expect(
        stages.some((stage) => stage.stage === "validate" && stage.stage_state === "running"),
      ).toBe(true);
      expect(status).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps historical no-command projections on the existing status-only path", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue({ ...base, status: "COMPLETED" });
    const emitStatus = vi.fn<(value: WorkflowRecord) => Promise<void>>(async () => undefined);
    const emitCommand = vi.fn<(activity: WorkflowTelemetry) => Promise<void>>(
      async () => undefined,
    );
    await monitorOwwWorkflow(runId, emitStatus, call, emitCommand);
    expect(emitStatus).toHaveBeenCalledOnce();
    expect(emitCommand).not.toHaveBeenCalled();
  });
});
