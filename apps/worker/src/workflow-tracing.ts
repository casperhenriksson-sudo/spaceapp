import {
  ContinueAsNew, TemporalFailure, isCancellation, proxySinks, workflowInfo,
  type WorkflowInterceptors, type Sinks
} from "@temporalio/workflow";
import { categorizeFailureCode, formatTraceparent, isSafeErrorCode, parseTraceparent } from "@space/contracts";
import {
  executionSpanId, executionTraceId, readTraceCarrier, traceLinks, withTraceCarrier,
  workflowCorrelation, workerSpanAttributes, type TraceCarrier, type TraceLink
} from "./trace-propagation.js";

export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | number>;
  links: TraceLink[];
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
}
export interface WorkflowTraceSinks extends Sinks {
  spaceTracing: { record(span: WorkflowSpanRecord): void };
}

/** No I/O, random numbers, new activities or business-input mutation in this module. */
export function interceptors(): WorkflowInterceptors {
  const sink = proxySinks<WorkflowTraceSinks>().spaceTracing;
  const initial = workflowInfo();
  const spanId = executionSpanId(initial.runId);
  let traceId = executionTraceId(initial.runId);
  let parentSpanId: string | null = null;
  let flags = "01";
  let links: TraceLink[] = [];
  let ids: Record<string, string> = {};
  const carrier = (): TraceCarrier => ({ traceparent: formatTraceparent(traceId, spanId, flags), links: [] });
  const link = (): TraceLink => ({ traceId, spanId });
  const childCarrier = (args: readonly unknown[]): TraceCarrier => {
    const explicit = workflowCorrelation(args);
    const parent = parseTraceparent(explicit.traceparent);
    // Each newly submitted mission retains its API request trace, even when a
    // long-lived supervisor was originally started by another request.
    return !explicit.background && parent && parent.traceId !== traceId
      ? { traceparent: formatTraceparent(parent.traceId, parent.parentId, parent.flags), links: [link()] }
      : carrier();
  };
  return {
    inbound: [{
      async execute(input, next) {
        // Temporal decodes memo after creating the interceptor factory. Read
        // the current info here; the factory's earlier snapshot has no memo.
        const info = workflowInfo();
        const correlation = workflowCorrelation(input.args);
        ids = correlation.ids;
        const header = readTraceCarrier(input.headers);
        const parent = parseTraceparent(header?.traceparent ?? correlation.traceparent ?? info.memo?.traceparent);
        links = traceLinks(header?.links);
        if (correlation.background && !info.continuedFromExecutionRunId) {
          // Background work gets a new trace with a causal link to the source
          // request's real span, rather than an invented API parent.
          const source = parseTraceparent(correlation.traceparent);
          links = traceLinks([...(source ? [{ traceId: source.traceId, spanId: source.parentId }] : []), ...links,
            ...(parent ? [{ traceId: parent.traceId, spanId: parent.parentId }] : [])]);
        } else if (parent) {
          traceId = parent.traceId; parentSpanId = parent.parentId; flags = parent.flags;
        }
        if (info.continuedFromExecutionRunId && !links.some(item => item.spanId === executionSpanId(info.continuedFromExecutionRunId!))) {
          links = traceLinks([{ traceId, spanId: executionSpanId(info.continuedFromExecutionRunId) }, ...links]);
        }
        let outcome: WorkflowSpanRecord["outcome"] | null = "COMPLETED";
        let reasonCode: string | null = null;
        try { return await next(input); }
        catch (error) {
          outcome = error instanceof ContinueAsNew ? "CONTINUED_AS_NEW"
            : isCancellation(error) ? "CANCELLED" : error instanceof TemporalFailure ? "FAILED" : null;
          if (outcome === "CANCELLED") reasonCode = "WORKFLOW_CANCELLED";
          if (outcome === "FAILED") {
            reasonCode = "WORKFLOW_ERROR";
            let failure: unknown = error;
            for (let depth = 0; depth < 4 && failure && typeof failure === "object"; depth++) {
              const record = failure as { type?: unknown; cause?: unknown };
              if (isSafeErrorCode(record.type)) { reasonCode = record.type; break; }
              failure = record.cause;
            }
          }
          // An ordinary Error retries the WorkflowTask, not the execution.
          throw error;
        } finally {
          if (outcome) {
            const startMs = info.runStartTime.getTime();
            const endMs = Math.max(startMs, Date.now());
            sink.record({ traceId, spanId, parentSpanId, startMs, endMs, links, outcome,
              attributes: workerSpanAttributes({ ...ids, "space.workflow_id": info.workflowId,
                "space.run_id": info.runId, "space.workflow_type": info.workflowType, "space.outcome": outcome,
                "space.duration_ms": endMs - startMs, "space.continued_from_run_id": info.continuedFromExecutionRunId,
                "space.reason_code": reasonCode, "space.category": reasonCode ? categorizeFailureCode(reasonCode) : null }) });
          }
        }
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: withTraceCarrier(input.headers, carrier()) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: withTraceCarrier(input.headers, carrier()) }),
      startChildWorkflowExecution: (input, next) => next({ ...input,
        headers: withTraceCarrier(input.headers, childCarrier(input.options.args ?? [])) }),
      continueAsNew: (input, next) => next({ ...input, headers: withTraceCarrier(input.headers, {
        traceparent: formatTraceparent(traceId, parentSpanId ?? spanId, flags), links: [link()]
      }) })
    }]
  };
}
