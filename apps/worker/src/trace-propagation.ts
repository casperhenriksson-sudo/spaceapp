import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import { formatTraceparent, parseTraceparent } from "@space/contracts";

/** Pure, bounded carrier code: safe in both the workflow isolate and Node. */
export const TRACE_HEADER = "space.trace-context.v1";
export interface TraceLink { traceId: string; spanId: string }
export interface TraceCarrier { traceparent: string; links: TraceLink[] }
export interface WorkflowCorrelation {
  traceparent: string | null;
  background: boolean;
  ids: Record<string, string>;
}

const identifier = /^[A-Za-z0-9:._-]{1,200}$/;
const hexTrace = /^(?!0{32}$)[0-9a-f]{32}$/;
const hexSpan = /^(?!0{16}$)[0-9a-f]{16}$/;
export const traceIdentifier = (value: unknown): string | null =>
  typeof value === "string" && identifier.test(value) ? value : null;

/** Stable ids consume neither workflow randomness nor commands, preserving old histories. */
export function executionSpanId(runId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < runId.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(runId.charCodeAt(i))) * 0x100000001b3n);
  return (hash || 1n).toString(16).padStart(16, "0");
}

export function executionTraceId(runId: string): string {
  const compact = runId.replace(/-/g, "").toLowerCase();
  return hexTrace.test(compact) ? compact : executionSpanId(`trace:${runId}`) + executionSpanId(`root:${runId}`);
}

/** Links contain only valid OTLP ids; no arbitrary attributes or payloads survive. */
export function traceLinks(value: unknown): TraceLink[] {
  if (!Array.isArray(value)) return [];
  const result: TraceLink[] = [];
  for (const candidate of value.slice(0, 4)) {
    if (!candidate || typeof candidate !== "object") continue;
    const link = candidate as Partial<TraceLink>;
    if (typeof link.traceId !== "string" || typeof link.spanId !== "string" || !hexTrace.test(link.traceId) || !hexSpan.test(link.spanId)) continue;
    if (!result.some(other => other.traceId === link.traceId && other.spanId === link.spanId)) result.push({ traceId: link.traceId, spanId: link.spanId });
  }
  return result;
}

export function readTraceCarrier(headers: Headers | undefined): TraceCarrier | null {
  const payload = headers?.[TRACE_HEADER];
  if (!payload || !payload.data || payload.data.length > 4096) return null;
  try {
    const value = defaultPayloadConverter.fromPayload(payload) as Partial<TraceCarrier> | null;
    const parsed = parseTraceparent(value?.traceparent);
    return parsed ? { traceparent: formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags), links: traceLinks(value?.links) } : null;
  } catch { return null; }
}

export function withTraceCarrier(headers: Headers, carrier: TraceCarrier): Headers {
  return { ...headers, [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceparent: carrier.traceparent, links: traceLinks(carrier.links) }) };
}

const idFields = { roomId: "space.room_id", paneId: "space.pane_id", missionId: "space.mission_id", roomAgentMissionId: "space.mission_id" } as const;

/** Read only known input containers, with fixed depth and work bounds, never user text. */
export function workflowCorrelation(args: readonly unknown[]): WorkflowCorrelation {
  const found: WorkflowCorrelation = { traceparent: null, background: false, ids: {} };
  let remaining = 48;
  let contextFound = false;
  const visit = (value: unknown, depth: number) => {
    if (--remaining < 0 || depth < 0 || !value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const parent = parseTraceparent(record.traceparent);
    const background = typeof record.traceId === "string" && record.traceId.startsWith("trace:bg-") &&
      Boolean(record.roomAgentContinuation && typeof record.roomAgentContinuation === "object");
    // The first context owns both fields. A later argument containing another
    // mission must not relabel the current execution as a background run.
    if (!contextFound && (parent || background)) {
      contextFound = true;
      found.traceparent = parent ? formatTraceparent(parent.traceId, parent.parentId, parent.flags) : null;
      found.background = background;
    }
    for (const [key, attribute] of Object.entries(idFields)) {
      const safe = traceIdentifier(record[key]);
      if (safe && found.ids[attribute] === undefined) found.ids[attribute] = safe;
    }
    for (const key of ["turn", "item", "bridge", "input", "turnInput"]) visit(record[key], depth - 1);
    // A supervisor may start with its first mission already queued.
    if (Array.isArray(record.pending)) for (const item of record.pending.slice(0, 1)) visit(item, depth - 1);
  };
  for (const arg of args.slice(0, 8)) visit(arg, 3);
  return found;
}

export const WORKER_SPAN_ATTRIBUTES = [
  "space.workflow_id", "space.run_id", "space.workflow_type", "space.room_id", "space.pane_id", "space.mission_id",
  "space.activity_type", "space.activity_id", "space.attempt", "space.outcome", "space.reason_code", "space.category",
  "space.duration_ms", "space.continued_from_run_id"
] as const;

/** Defense at both construction and sink boundaries; no spread of caller attributes. */
export function workerSpanAttributes(input: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const key of WORKER_SPAN_ATTRIBUTES) {
    const value = input[key];
    if (key === "space.attempt" || key === "space.duration_ms") {
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= (key === "space.attempt" ? 1 : 0)) result[key] = value;
    } else {
      const safe = traceIdentifier(value);
      if (safe) result[key] = safe;
    }
  }
  return result;
}
