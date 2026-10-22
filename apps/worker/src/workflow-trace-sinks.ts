import { fileURLToPath } from "node:url";
import type { InjectedSinks, WorkerOptions } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import type { WorkflowTraceSinks } from "./workflow-tracing.js";
import { executionSpanId, traceIdentifier, traceLinks, workerSpanAttributes } from "./trace-propagation.js";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";

/** Export only after leaving the isolate. Replay suppression is explicit. */
export function createWorkflowTraceSinks(spans: SpanExporter): InjectedSinks<WorkflowTraceSinks> {
  const seen = new Set<string>();
  return { spaceTracing: { record: {
    callDuringReplay: false,
    fn(info, record) {
      try {
        if (!/^(?!0{32}$)[0-9a-f]{32}$/.test(record.traceId) || record.spanId !== executionSpanId(info.runId)) return;
        if (record.parentSpanId !== null && !/^(?!0{16}$)[0-9a-f]{16}$/.test(record.parentSpanId)) return;
        if (!Number.isSafeInteger(record.startMs) || !Number.isSafeInteger(record.endMs) || record.startMs < 0 || record.endMs < record.startMs) return;
        const key = `${record.traceId}:${record.spanId}`;
        if (seen.has(key)) return;
        // Also suppress a repeated terminal sink call after a WorkflowTask retry;
        // bounded process-local memory is not a durable exactly-once claim.
        if (seen.size >= 4096) seen.delete(seen.values().next().value!);
        seen.add(key);
        const workflowType = traceIdentifier(info.workflowType) ?? "unknown";
        spans.record({ traceId: record.traceId, spanId: record.spanId, parentSpanId: record.parentSpanId,
          name: `workflow ${workflowType}`, kind: 1, error: record.outcome === "FAILED",
          startTimeUnixNano: BigInt(record.startMs) * 1_000_000n, endTimeUnixNano: BigInt(record.endMs) * 1_000_000n,
          attributes: workerSpanAttributes({ ...record.attributes, "space.workflow_id": info.workflowId,
            "space.run_id": info.runId, "space.workflow_type": workflowType, "space.outcome": record.outcome }),
          links: traceLinks(record.links) });
      } catch { /* Telemetry never changes workflow work or worker availability. */ }
    }
  } } };
}

/** One construction path for the main, maintenance and mutation workers. */
export function workerTracingOptions(spans: SpanExporter | null): Pick<WorkerOptions, "interceptors" | "sinks"> {
  return {
    interceptors: { activity: [createActivityObservabilityInterceptors({ spans })],
      ...(spans ? { workflowModules: [fileURLToPath(new URL(
        import.meta.url.endsWith(".ts") ? "./workflow-tracing.ts" : "./workflow-tracing.js", import.meta.url
      ))] } : {}) },
    ...(spans ? { sinks: createWorkflowTraceSinks(spans) } : {})
  };
}
