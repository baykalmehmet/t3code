import { describe, expect, it, vi } from "vite-plus/test";
import {
  classifyOwwRequest,
  monitorOwwWorkflow,
  resolveOwwApprovalAction,
  submitOwwRequest,
  type WorkflowCall,
  type WorkflowRecord,
} from "./owwWorkflow.ts";

const runId = "12345678-1234-1234-1234-123456789abc";
const candidate = "a".repeat(40);
const base: WorkflowRecord = {
  run_id: runId,
  status: "RUNNING",
  project: "oww",
  original_task: "Fix it",
};
const request = {
  workspace: "/opt/agent-platform/projects/oww/repo",
  threadId: "thread-1",
  messageId: "message-1",
  text: "Fix the application",
};

describe("OWW Hatchet dispatch", () => {
  it("starts a typed Hatchet run without model selection from chat", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue(base);
    const result = await submitOwwRequest(request, call);
    expect(result).toEqual({ handled: true, workflow: base, resume: true });
    expect(call).toHaveBeenCalledWith(
      "start_task",
      expect.objectContaining({
        project_id: "oww",
        task: request.text,
        work_kind: "application_change",
        execution_profile: "default",
        request_id: expect.stringMatching(/^t3-[a-f0-9]{64}$/),
      }),
    );
  });

  it("binds continue and status to the existing run and never creates another", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue(base);
    await submitOwwRequest(request, call);
    call.mockClear();
    await submitOwwRequest({ ...request, messageId: "m2", text: "continue" }, call);
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_run_details", "get_run_status"]);
    expect(call).not.toHaveBeenCalledWith("start_task", expect.anything());
  });

  it.each([
    "do not approve",
    "do not retry",
    "must not cancel the run",
    "never approve the migration",
  ])("explicit negation performs no mutation: %s", async (text) => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue({ ...base, candidate_sha: candidate });
    await submitOwwRequest(request, call);
    call.mockClear();
    await submitOwwRequest({ ...request, messageId: "m2", text }, call);
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_run_details"]);
    expect(call).not.toHaveBeenCalledWith(
      expect.stringMatching(/approve|retry|cancel/),
      expect.anything(),
    );
    expect(call).not.toHaveBeenCalledWith("start_task", expect.anything());
  });

  it("do not create another task; status queries the bound run", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue(base);
    await submitOwwRequest(request, call);
    call.mockClear();
    await submitOwwRequest(
      { ...request, messageId: "m2", text: "do not create another task; show status" },
      call,
    );
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_run_details", "get_run_status"]);
    expect(call).not.toHaveBeenCalledWith("start_task", expect.anything());
  });

  it("does not mistake status prose in an engineering request for a control command", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue(base);
    const text = [
      "Improve the visual design and overall theme of Zyncal.",
      "9. Status indicators and badges",
      "Standardise status badges and indicators across Zyncal.",
    ].join("\n\n");

    const result = await submitOwwRequest(
      { ...request, threadId: "thread-status-prose", messageId: "status-prose", text },
      call,
    );

    expect(result).toEqual({ handled: true, workflow: base, resume: true });
    expect(call).toHaveBeenCalledWith("start_task", expect.objectContaining({ task: text }));
    expect(call).not.toHaveBeenCalledWith("get_run_details", expect.anything());
  });

  it("requires an explicit new-task prefix once a conversation is bound", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue(base);
    await submitOwwRequest(request, call);
    call.mockClear();
    const bound = await submitOwwRequest(
      { ...request, messageId: "m2", text: "Add another feature" },
      call,
    );
    expect(bound).toEqual(
      expect.objectContaining({
        resume: false,
        notice: expect.stringContaining("Start new task:"),
      }),
    );
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_run_status"]);
    call.mockClear();
    await submitOwwRequest(
      { ...request, messageId: "m3", text: "Start new task: Add another feature" },
      call,
    );
    expect(call).toHaveBeenCalledWith(
      "start_task",
      expect.objectContaining({ task: "Add another feature" }),
    );
  });

  it("starts a preserved-candidate repair run only for an explicit repair instruction", async () => {
    const failed: WorkflowRecord = {
      ...base,
      status: "COMPLETED",
      outcome: "engineering_failure",
      candidate_sha: candidate,
      tasks: [
        {
          task_id: "review-task",
          name: "review",
          status: "COMPLETED",
          output: {
            findings: [
              {
                severity: "security",
                file: "oww/Services/Auth.cs",
                line: 12,
                message: "Fix auth boundary",
              },
            ],
          },
        },
      ],
    };
    const repaired = { ...base, run_id: "22345678-1234-1234-1234-123456789abc", status: "QUEUED" };
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async (name) => (name === "get_run_details" ? failed : repaired));
    const result = await submitOwwRequest(
      { ...request, threadId: "repair-thread", text: "repair: bind the endpoint to the tenant" },
      call,
    );
    expect(result).toEqual({ handled: true, workflow: repaired, resume: true });
    expect(call).toHaveBeenLastCalledWith(
      "start_task",
      expect.objectContaining({
        base_sha: candidate,
        task: expect.stringContaining("Fix auth boundary"),
      }),
    );
  });

  it("accepts a run ID before the repair instruction", async () => {
    const failed: WorkflowRecord = {
      ...base,
      status: "COMPLETED",
      outcome: "engineering_failure",
      candidate_sha: candidate,
    };
    const repaired = { ...base, run_id: "32345678-1234-1234-1234-123456789abc", status: "QUEUED" };
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async (name) => (name === "get_run_details" ? failed : repaired));
    const result = await submitOwwRequest(
      { ...request, threadId: "repair-run-id", text: `repair ${runId}: fix the review findings` },
      call,
    );
    expect(result).toEqual({ handled: true, workflow: repaired, resume: true });
    expect(call).toHaveBeenLastCalledWith(
      "start_task",
      expect.objectContaining({ base_sha: candidate }),
    );
  });

  it("allows explicit repair IDs from a fresh chat before workspace selection", async () => {
    const failed: WorkflowRecord = {
      ...base,
      status: "COMPLETED",
      outcome: "engineering_failure",
      candidate_sha: candidate,
    };
    const repaired = { ...base, run_id: "42345678-1234-1234-1234-123456789abc", status: "QUEUED" };
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async (name) => (name === "get_run_details" ? failed : repaired));
    const result = await submitOwwRequest(
      {
        ...request,
        workspace: "/tmp/unselected",
        threadId: "fresh-repair",
        text: `repair: use the candidate for run ${runId}`,
      },
      call,
    );
    expect(result).toEqual({ handled: true, workflow: repaired, resume: true });
  });

  it("sends a typed decision only for Hatchet's exact candidate", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue({ ...base, candidate_sha: candidate });
    await submitOwwRequest(request, call);
    call.mockClear();
    await submitOwwRequest(
      { ...request, messageId: "m2", text: `approve candidate ${candidate}` },
      call,
    );
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_run_details", "approve_candidate"]);
    expect(call).toHaveBeenLastCalledWith(
      "approve_candidate",
      expect.objectContaining({ run_id: runId, candidate_sha: candidate }),
    );
  });

  it("does not retry unless exactly one Hatchet child task is failed", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue(base);
    await submitOwwRequest(request, call);
    call.mockClear();
    const result = await submitOwwRequest({ ...request, messageId: "m2", text: "retry" }, call);
    expect(result).toEqual(
      expect.objectContaining({ resume: false, notice: expect.stringContaining("exactly one") }),
    );
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_run_details"]);
  });

  it("leaves read-only and platform administration requests outside task creation", async () => {
    const call = vi.fn<WorkflowCall>();
    expect(await submitOwwRequest({ ...request, text: "Explain this code" }, call)).toEqual({
      handled: false,
    });
    expect(classifyOwwRequest("Platform administration: inspect Hatchet")).toBe("administration");
    expect(call).not.toHaveBeenCalled();
  });
});

describe("OWW Hatchet activity monitoring", () => {
  it("suppresses repeated activity and emits bounded live status refreshes", async () => {
    vi.useFakeTimers();
    const values: WorkflowRecord[] = [
      {
        ...base,
        current_task: "develop",
        current_task_status: "RUNNING",
        current_activity: "Implementing requested behavior",
        stage_elapsed_seconds: 5,
      },
      {
        ...base,
        current_task: "develop",
        current_task_status: "RUNNING",
        current_activity: "Implementing requested behavior",
        stage_elapsed_seconds: 20,
      },
      {
        ...base,
        current_task: "develop",
        current_task_status: "RUNNING",
        current_activity: "Checking changed files",
        stage_elapsed_seconds: 61,
      },
      {
        ...base,
        status: "COMPLETED",
        work_kind: "application_change",
        outcome: "engineering_failure",
        summary: "Stopped safely",
      },
    ];
    let index = 0;
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async () => values[Math.min(index++, values.length - 1)]!);
    const emit = vi.fn<(value: WorkflowRecord) => Promise<void>>(async () => undefined);
    try {
      const monitoring = monitorOwwWorkflow(runId, emit, call);
      await vi.runAllTimersAsync();
      await monitoring;
      expect(emit).toHaveBeenCalledTimes(3);
      expect(emit.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          compact_progress: true,
          current_activity: "Implementing requested behavior",
        }),
      );
      expect(emit.mock.calls[1]![0]).toEqual(
        expect.objectContaining({
          current_activity: "Checking changed files",
          stage_elapsed_seconds: 61,
        }),
      );
      expect(emit.mock.calls[2]![0]).toEqual(expect.objectContaining({ status: "COMPLETED" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OWW native approval actions", () => {
  const waitingCandidate: WorkflowRecord = {
    ...base,
    current_task: "application-change",
    current_task_status: "WAITING",
    waiting_reason: "candidate approval for the exact candidate SHA",
    candidate_sha: candidate,
  };

  it.each([
    ["accept", "approve_candidate"],
    ["decline", "reject_candidate"],
  ] as const)("maps candidate %s to typed %s", async (decision, operation) => {
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async (name) =>
        name === "get_run_details" ? waitingCandidate : { ...waitingCandidate, status: "RUNNING" },
      );
    const result = await resolveOwwApprovalAction({
      requestId: `hatchet:${runId}:candidate:${candidate}`,
      decision,
      threadId: "thread-approval",
      call,
    });
    expect(result).toEqual(expect.objectContaining({ handled: true, action: "candidate" }));
    expect(call).toHaveBeenLastCalledWith(
      operation,
      expect.objectContaining({ run_id: runId, candidate_sha: candidate }),
    );
  });

  it("rejects stale candidate controls before any typed mutation", async () => {
    const call = vi.fn<WorkflowCall>().mockResolvedValue({
      ...waitingCandidate,
      candidate_sha: "b".repeat(40),
    });
    await expect(
      resolveOwwApprovalAction({
        requestId: `hatchet:${runId}:candidate:${candidate}`,
        decision: "accept",
        threadId: "thread-approval",
        call,
      }),
    ).rejects.toThrow("stale Hatchet candidate approval");
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_run_details"]);
  });

  it("treats an exact candidate approval as idempotent after the workflow advances", async () => {
    const advanced: WorkflowRecord = {
      ...waitingCandidate,
      current_task_status: "RUNNING",
      waiting_reason: undefined,
    };
    const call = vi.fn<WorkflowCall>().mockResolvedValue(advanced);
    const result = await resolveOwwApprovalAction({
      requestId: `hatchet:${runId}:candidate:${candidate}`,
      decision: "accept",
      threadId: "thread-approval",
      call,
    });
    expect(result).toEqual(expect.objectContaining({ handled: true, resume: true }));
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_run_details"]);
  });

  it.each([
    ["accept", "approve_migration"],
    ["decline", "reject_migration"],
  ] as const)(
    "maps migration %s to typed %s with the exact merged SHA",
    async (decision, operation) => {
      const merged = "b".repeat(40);
      const waiting: WorkflowRecord = {
        ...base,
        current_task: "application-change",
        current_task_status: "WAITING",
        waiting_reason: "migration approval for the exact merged SHA",
        merged_sha: merged,
      };
      const call = vi
        .fn<WorkflowCall>()
        .mockImplementation(async (name) => (name === "get_run_details" ? waiting : waiting));
      await resolveOwwApprovalAction({
        requestId: `hatchet:${runId}:migration:${merged}`,
        decision,
        threadId: "thread-approval",
        call,
      });
      expect(call).toHaveBeenLastCalledWith(
        operation,
        expect.objectContaining({ run_id: runId, merged_sha: merged }),
      );
    },
  );

  it("maps retry only to the exact failed Hatchet child task", async () => {
    const taskId = "87654321-4321-4321-4321-cba987654321";
    const failed: WorkflowRecord = {
      ...base,
      status: "COMPLETED",
      retryable_task_id: taskId,
      retryable_task_name: "validate",
      tasks: [{ task_id: taskId, name: "validate", status: "FAILED" }],
    };
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async (name) =>
        name === "get_run_details" ? failed : { ...failed, status: "RUNNING" },
      );
    await resolveOwwApprovalAction({
      requestId: `hatchet:${runId}:retry:${taskId}`,
      decision: "accept",
      threadId: "thread-approval",
      call,
    });
    expect(call).toHaveBeenLastCalledWith("retry_failed_task", {
      run_id: runId,
      task_run_id: taskId,
    });
  });

  it("maps an explicit accepted cancel action to cancel_run", async () => {
    const call = vi
      .fn<WorkflowCall>()
      .mockImplementation(async (name) =>
        name === "get_run_details" ? base : { ...base, status: "CANCELLED" },
      );
    await resolveOwwApprovalAction({
      requestId: `hatchet:${runId}:cancel:${runId}`,
      decision: "accept",
      threadId: "thread-approval",
      call,
    });
    expect(call).toHaveBeenLastCalledWith("cancel_run", { run_id: runId });
    expect(call.mock.calls.some(([name]) => String(name).includes("merge"))).toBe(false);
  });
});
