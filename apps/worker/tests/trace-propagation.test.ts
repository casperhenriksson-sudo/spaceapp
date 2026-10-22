import { describe, expect, it, vi } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import { otlpTraceRequest, type ServerSpan, type SpanExporter } from "@space/runtime";
import { childTraceparent, noteActivityFailureReason, observeActivityExecution } from "../src/activity-observability.js";
import { createWorkflowTraceSinks, workerTracingOptions } from "../src/workflow-trace-sinks.js";
import {
  TRACE_HEADER, WORKER_SPAN_ATTRIBUTES, executionSpanId, executionTraceId,
  readTraceCarrier, traceLinks, withTraceCarrier, workerSpanAttributes, workflowCorrelation
} from "../src/trace-propagation.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;
const secret = "PRIVATE PROMPT /home/private?token=sk-secret https://private.invalid";
const info = { activityType: "stub", activityId: "1", attempt: 2, workflowType: "fixture",
  workflowExecution: { workflowId: "workflow:test", runId: "run:test" }, currentAttemptScheduledTimestampMs: 0 };
function capture() {
  const records: ServerSpan[] = [];
  const exporter: SpanExporter = { record: span => { records.push(span); }, flush: async () => {}, close: async () => {},
    stats: () => ({ exported: records.length, dropped: 0, failed: 0 }) };
  return { records, exporter };
}

describe("bounded workflow trace context", () => {
  it("roundtrips the private header while preserving other headers and dropping arbitrary link data", () => {
    const other = defaultPayloadConverter.toPayload("business header");
    const headers = withTraceCarrier({ other }, { traceparent, links: [{ traceId, spanId: parentId, prompt: secret } as never] });
    expect(headers.other).toBe(other);
    expect(readTraceCarrier(headers)).toEqual({ traceparent, links: [{ traceId, spanId: parentId }] });
    expect(defaultPayloadConverter.fromPayload(headers[TRACE_HEADER]!)).not.toHaveProperty("prompt");
  });
  it("rejects malformed, oversized, empty and zero-id carriers without throwing", () => {
    for (const payload of [undefined, { data: new Uint8Array(4097) }, { data: new Uint8Array([255]) },
      defaultPayloadConverter.toPayload({ traceparent: `00-${"0".repeat(32)}-${parentId}-01` }),
      defaultPayloadConverter.toPayload(null), defaultPayloadConverter.toPayload(secret)]) {
      expect(readTraceCarrier({ [TRACE_HEADER]: payload } as never)).toBeNull();
    }
    expect(traceLinks([{ traceId, spanId: "0".repeat(16) }, { traceId, spanId: parentId },
      { traceId, spanId: parentId }, { traceId, spanId: "1111111111111111" },
      { traceId, spanId: "2222222222222222" }])).toEqual([
      { traceId, spanId: parentId }, { traceId, spanId: "1111111111111111" }
    ]);
  });
  it("derives stable nonzero execution ids without consuming workflow randomness", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("random consumed"); });
    try {
      expect(executionSpanId("run:test")).toMatch(/^(?!0{16}$)[0-9a-f]{16}$/);
      expect(executionSpanId("run:test")).toBe(executionSpanId("run:test"));
      expect(executionSpanId("run:other")).not.toBe(executionSpanId("run:test"));
      expect(executionTraceId("12345678-1234-1234-1234-123456789abc")).toBe("12345678123412341234123456789abc");
    } finally { random.mockRestore(); }
  });
  it("bounds cyclic business inputs and reads only known identifier containers", () => {
    const value: Record<string, unknown> = { turn: { roomId: "room:test", traceparent, prompt: secret }, prompt: secret };
    value.input = value;
    expect(workflowCorrelation([value])).toEqual({ traceparent, background: false, ids: { "space.room_id": "room:test" } });
    expect(workflowCorrelation([{ prompt: { traceparent }, roomId: secret }])).toEqual({ traceparent: null, background: false, ids: {} });
    expect(workflowCorrelation([{ turn: { traceId: "trace:bg-one", roomAgentContinuation: { sourceRunId: "run:old" } } }]).background).toBe(true);
    expect(workflowCorrelation([{ traceparent }, { traceId: "trace:bg-later", roomAgentContinuation: { sourceRunId: "run:later" } }]))
      .toMatchObject({ traceparent, background: false });
  });
  it("enforces the attribute allowlist at the exporter boundary", () => {
    expect(workerSpanAttributes({ "space.attempt": 2, "space.duration_ms": 3, "space.room_id": "room:one",
      "space.workflow_id": secret, prompt: secret, "space.output": secret, "space.reason_code": secret,
      "space.category": secret, "space.pane_id": "a".repeat(201) }))
      .toEqual({ "space.room_id": "room:one", "space.attempt": 2, "space.duration_ms": 3 });
    expect(workerSpanAttributes({ "space.attempt": 0, "space.duration_ms": NaN })).toEqual({});
  });
});

describe("activity trace parent and failure boundaries", () => {
  it("uses the workflow header over stale business args and propagates its recorded activity span", async () => {
    const { records, exporter } = capture();
    let outbound: string | null = null;
    const result = await observeActivityExecution(info, [{ traceparent: `00-${"1".repeat(32)}-${parentId}-01`, prompt: secret }], async () => {
      outbound = childTraceparent(traceparent);
      expect(childTraceparent(undefined)).toBe(outbound);
      noteActivityFailureReason("ACTIVITY_TIMEOUT");
      return { status: "FAILED", message: secret };
    }, { spans: exporter, traceCarrier: { traceparent, links: [] } });
    expect(result.status).toBe("FAILED");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ traceId, parentSpanId: parentId, error: true,
      attributes: { "space.attempt": 2, "space.outcome": "FAILED_RESULT", "space.reason_code": "ACTIVITY_TIMEOUT", "space.category": "TIMEOUT" } });
    expect(outbound).toBe(`00-${traceId}-${records[0]!.spanId}-01`);
    expect(Object.keys(records[0]!.attributes).every(key => (WORKER_SPAN_ATTRIBUTES as readonly string[]).includes(key))).toBe(true);
    expect(JSON.stringify(otlpTraceRequest(records, "space-worker"))).not.toContain(secret);
  });
  it("preserves results and the original thrown error when telemetry fails", async () => {
    const { exporter } = capture();
    exporter.record = () => { throw new Error("collector unavailable"); };
    await expect(observeActivityExecution(info, [{ traceparent }], async () => "done", { spans: exporter })).resolves.toBe("done");
    const original = new Error(secret);
    await expect(observeActivityExecution(info, [{ traceparent }], async () => { throw original; }, { spans: exporter })).rejects.toBe(original);
  });
});

describe("workflow sink and worker registration", () => {
  it("suppresses replay and duplicate calls and rebuilds trusted execution attributes", () => {
    const { records, exporter } = capture();
    const record = createWorkflowTraceSinks(exporter).spaceTracing.record;
    expect(record.callDuringReplay).toBe(false);
    const execution = { runId: "run:test", workflowId: "workflow:test", workflowType: "fixture" };
    const span = { traceId, spanId: executionSpanId(execution.runId), parentSpanId: parentId, startMs: 1, endMs: 2,
      attributes: { prompt: secret, "space.workflow_id": "forged", "space.room_id": secret }, links: [], outcome: "COMPLETED" as const };
    record.fn(execution as never, span);
    record.fn(execution as never, span);
    record.fn(execution as never, { ...span, spanId: parentId });
    expect(records).toHaveLength(1);
    expect(records[0]!.attributes).toMatchObject({ "space.workflow_id": execution.workflowId, "space.run_id": execution.runId });
    expect(JSON.stringify(otlpTraceRequest(records, "space-worker"))).not.toContain(secret);
  });
  it("installs workflow modules and sinks only when export is enabled", () => {
    const { exporter } = capture();
    expect(workerTracingOptions(null).sinks).toBeUndefined();
    expect(workerTracingOptions(null).interceptors?.workflowModules).toBeUndefined();
    expect(workerTracingOptions(null).interceptors?.activity).toHaveLength(1);
    expect(workerTracingOptions(exporter).interceptors?.workflowModules).toHaveLength(1);
    expect(workerTracingOptions(exporter).sinks?.spaceTracing?.record?.callDuringReplay).toBe(false);
  });
  it("serializes only valid OTLP link ids and leaves existing API spans unchanged without links", () => {
    const span: ServerSpan = { traceId, spanId: parentId, parentSpanId: null, name: "fixture", startTimeUnixNano: 1n,
      endTimeUnixNano: 2n, attributes: {}, error: false };
    const encoded = (value: ServerSpan) => otlpTraceRequest([value], "fixture").resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(encoded(span)).not.toHaveProperty("links");
    expect(encoded({ ...span, links: [{ traceId, spanId: parentId }, { traceId: "0".repeat(32), spanId: parentId }] }).links)
      .toEqual([{ traceId, spanId: parentId }]);
  });
});
