import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { createHttpObservability } from "../../api/src/observability.js";
import { requestTraceContexts, traceContextForRawRequest, withTurnTraceparent } from "../../api/src/trace-context.js";
import { createWorkflowTraceSinks, workerTracingOptions } from "../src/workflow-trace-sinks.js";
import { WORKER_SPAN_ATTRIBUTES, executionSpanId } from "../src/trace-propagation.js";

interface CollectedSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  links?: Array<{ traceId: string; spanId: string }>;
}
interface TraceRequest {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: CollectedSpan[] }> }>;
}
const workflowsPath = fileURLToPath(new URL("./support/trace-workflows.ts", import.meta.url));
const secret = "PRIVATE PROMPT sk-live-otlp-fixture /private/file https://secret.invalid";
const attributes = (span: CollectedSpan) => Object.fromEntries(span.attributes.map(item => [item.key, item.value.stringValue ?? Number(item.value.intValue)]));

describe("real Temporal workflow to OTLP HTTP collector", () => {
  let environment: TestWorkflowEnvironment;
  let collector: Server;
  let endpoint: string;
  const requests: TraceRequest[] = [];
  const spans = () => requests.flatMap(request => request.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  beforeAll(async () => {
    collector = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url !== "/v1/traces" || request.method !== "POST") { response.writeHead(404).end(); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as TraceRequest);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address();
    if (!address || typeof address === "string") throw new Error("Collector did not bind TCP");
    endpoint = `http://127.0.0.1:${address.port}`;
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);
  afterAll(async () => {
    await environment?.teardown();
    if (collector) await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
  }, 30_000);
  const exporter = (serviceName = "space-worker") => createOtlpSpanExporter({ endpoint, serviceName, flushIntervalMs: 60_000 });
  async function worker(taskQueue: string, spanExporter: SpanExporter | null) {
    return Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace, taskQueue,
      workflowsPath, ...workerTracingOptions(spanExporter),
      activities: { tracedAttempt: async () => {
        if (Context.current().info.attempt === 1) throw ApplicationFailure.create({ message: secret, type: "ACTIVITY_TIMEOUT" });
        return "done";
      } }
    });
  }

  it("connects the actual API SERVER span, workflow, child workflow and every activity attempt", async () => {
    requests.length = 0;
    const workerExporter = exporter();
    const apiExporter = exporter("space-api");
    const app = Fastify();
    const observer = createHttpObservability({ serviceName: "space-api", spanExporter: apiExporter });
    app.addHook("onRequest", async request => observer.onRequest(request));
    app.addHook("onResponse", async (request, reply) => observer.onResponse(request, reply));
    const taskQueue = `trace-${randomUUID()}`;
    const workflowId = `workflow:${randomUUID()}`;
    app.post("/trace-fixture", async request => {
      requestTraceContexts.remember(request.id, traceContextForRawRequest(request.raw));
      const input = withTurnTraceparent({ traceId: request.id, roomId: "room:fixture", prompt: secret });
      const handle = await environment.client.workflow.start("traceWorkflow", { taskQueue, workflowId, args: [input] });
      return { result: await handle.result() };
    });
    try {
      const active = await worker(taskQueue, workerExporter);
      await active.runUntil(async () => {
        const response = await app.inject({ method: "POST", url: "/trace-fixture" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ result: "room:fixture" });
      });
      await Promise.all([apiExporter.flush(), workerExporter.flush()]);
      const collected = spans();
      const api = collected.find(span => span.kind === 2)!;
      const root = collected.find(span => span.name === "workflow traceWorkflow")!;
      const child = collected.find(span => span.name === "workflow traceChild")!;
      expect(api).toBeDefined(); expect(root).toBeDefined(); expect(child).toBeDefined();
      expect(root.parentSpanId).toBe(api.spanId);
      expect(child.parentSpanId).toBe(root.spanId);
      expect(new Set(collected.map(span => span.traceId))).toEqual(new Set([api.traceId]));
      const attempts = collected.filter(span => span.name === "activity tracedAttempt");
      expect(attempts).toHaveLength(4);
      for (const parent of [root, child]) {
        const executions = attempts.filter(span => span.parentSpanId === parent.spanId);
        expect(executions.map(span => attributes(span)["space.attempt"]).sort()).toEqual([1, 2]);
        expect(executions.find(span => attributes(span)["space.attempt"] === 1)).toMatchObject({
          attributes: expect.arrayContaining([
            { key: "space.reason_code", value: { stringValue: "ACTIVITY_TIMEOUT" } },
            { key: "space.category", value: { stringValue: "TIMEOUT" } }
          ])
        });
      }
      for (const span of collected.filter(span => span.kind === 1)) {
        expect(span.attributes.every(item => (WORKER_SPAN_ATTRIBUTES as readonly string[]).includes(item.key))).toBe(true);
      }
      expect(JSON.stringify(requests)).not.toMatch(/PRIVATE PROMPT|sk-live-otlp|private\/file|secret.invalid/);

      const history = await environment.client.workflow.getHandle(workflowId).fetchHistory();
      const replayExporter = exporter();
      const sinks = createWorkflowTraceSinks(replayExporter);
      let sinkCalls = 0;
      const record = sinks.spaceTracing.record.fn;
      sinks.spaceTracing.record.fn = (...args) => { sinkCalls++; return record(...args); };
      await Worker.runReplayHistory({ workflowsPath, interceptors: workerTracingOptions(replayExporter).interceptors, sinks }, history, workflowId);
      await replayExporter.close();
      expect(sinkCalls).toBe(0);
      expect(spans()).toHaveLength(collected.length);
    } finally {
      observer.close();
      await app.close();
      await Promise.all([workerExporter.close(), apiExporter.close()]);
    }
  }, 120_000);

  it("links continue-as-new runs and gives background continuations a linked new trace", async () => {
    requests.length = 0;
    const spanExporter = exporter();
    const taskQueue = `continue-${randomUUID()}`;
    const workflowId = `workflow:${randomUUID()}`;
    const sourceTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const sourceSpan = "00f067aa0ba902b7";
    const traceparent = `00-${sourceTrace}-${sourceSpan}-01`;
    const active = await worker(taskQueue, spanExporter);
    try {
      await active.runUntil(async () => {
        const handle = await environment.client.workflow.start("traceContinue", { taskQueue, workflowId, args: [{ traceparent }] });
        expect(await handle.result()).toBe("continued");
        const background = await environment.client.workflow.start("traceChild", { taskQueue, workflowId: `${workflowId}:background`,
          args: [{ traceparent, traceId: "trace:bg-fixture", roomAgentContinuation: { sourceRunId: "run:old" } }] });
        expect(await background.result()).toBe("done");
      });
      await spanExporter.flush();
      const runs = spans().filter(span => span.name === "workflow traceContinue");
      expect(runs).toHaveLength(2);
      const first = runs.find(span => attributes(span)["space.outcome"] === "CONTINUED_AS_NEW")!;
      const second = runs.find(span => attributes(span)["space.outcome"] === "COMPLETED")!;
      expect(second.links).toContainEqual({ traceId: first.traceId, spanId: first.spanId });
      expect(first.traceId).toBe(sourceTrace); expect(second.traceId).toBe(sourceTrace);
      const background = spans().find(span => span.name === "workflow traceChild")!;
      expect(background.traceId).not.toBe(sourceTrace);
      expect(background.parentSpanId).toBeUndefined();
      expect(background.links).toContainEqual({ traceId: sourceTrace, spanId: sourceSpan });
      expect(spans().filter(span => span.name === "activity tracedAttempt" && span.traceId === background.traceId))
        .toHaveLength(2);
    } finally { await spanExporter.close(); }
  }, 120_000);

  it("replays an uninstrumented history whose child id depends on workflow randomness", async () => {
    const taskQueue = `random-${randomUUID()}`;
    const workflowId = `workflow:${randomUUID()}`;
    const active = await worker(taskQueue, null);
    let runId = "";
    await active.runUntil(async () => {
      const handle = await environment.client.workflow.start("traceRandom", { taskQueue, workflowId });
      runId = handle.firstExecutionRunId;
      expect(await handle.result()).toBe("done");
    });
    const history = await environment.client.workflow.getHandle(workflowId).fetchHistory();
    const spanExporter = exporter();
    const before = spans().length;
    try {
      await Worker.runReplayHistory({ workflowsPath, ...workerTracingOptions(spanExporter) }, history, workflowId);
      await spanExporter.flush();
      expect(spans()).toHaveLength(before);
      expect(executionSpanId(runId)).toMatch(/^[0-9a-f]{16}$/);
    } finally { await spanExporter.close(); }
  }, 120_000);

  it("records terminal failures and cancellations without exception messages", async () => {
    requests.length = 0;
    const spanExporter = exporter();
    const taskQueue = `failure-${randomUUID()}`;
    const active = await worker(taskQueue, spanExporter);
    try {
      await active.runUntil(async () => {
        const failed = await environment.client.workflow.start("traceFailure", { taskQueue, workflowId: `workflow:${randomUUID()}` });
        await expect(failed.result()).rejects.toThrow();
        const cancelled = await environment.client.workflow.start("traceCancelled", { taskQueue, workflowId: `workflow:${randomUUID()}` });
        await cancelled.cancel();
        await expect(cancelled.result()).rejects.toThrow();
      });
      await spanExporter.flush();
      expect(attributes(spans().find(span => span.name === "workflow traceFailure")!)).toMatchObject({
        "space.outcome": "FAILED", "space.reason_code": "TOOL_UNAVAILABLE", "space.category": "TOOL_UNAVAILABLE"
      });
      expect(attributes(spans().find(span => span.name === "workflow traceCancelled")!)).toMatchObject({
        "space.outcome": "CANCELLED", "space.category": "CANCELLED"
      });
      expect(JSON.stringify(requests)).not.toMatch(/PRIVATE PROMPT|sk-live-failure|private\/file/);
    } finally { await spanExporter.close(); }
  }, 120_000);

  it("nests the real memory maintenance and consolidation workflows and their activities", async () => {
    requests.length = 0;
    const spanExporter = exporter("space-memory-maintenance-worker");
    const taskQueue = "space-memory-maintenance";
    const workflowId = `workflow:${randomUUID()}`;
    const active = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace,
      taskQueue, workflowsPath, ...workerTracingOptions(spanExporter), activities: {
        refreshMemoryGraphSnapshot: async () => ({ sourceHash: "fixture-source" }),
        refreshAllMonthsMemoryGraphSnapshot: async () => ({}),
        reconcileStaleSpaceAgentSessions: async () => ({}),
        createScheduledMemoryAudit: async () => ({ id: "memory_consolidation:fixture", workflowId: `${workflowId}:child` }),
        prepareMemoryConsolidation: async () => ({ changeSetId: null, run: { id: "memory_consolidation:fixture" } })
      } });
    try {
      await active.runUntil(async () => {
        await environment.client.workflow.execute("memoryMaintenanceWorkflow", { taskQueue, workflowId,
          args: [{ scheduledAt: "2026-10-22T12:00:00.000Z", traceId: "req:memory" }],
          memo: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } });
      });
      await spanExporter.flush();
      const parent = spans().find(span => span.name === "workflow memoryMaintenanceWorkflow")!;
      const child = spans().find(span => span.name === "workflow memoryConsolidationWorkflow")!;
      expect(parent).toBeDefined(); expect(child).toBeDefined();
      expect(parent.parentSpanId).toBe("00f067aa0ba902b7");
      expect(child.parentSpanId).toBe(parent.spanId);
      expect(child.traceId).toBe(parent.traceId);
      expect(spans().filter(span => span.name.startsWith("activity "))).toHaveLength(5);
      for (const span of spans().filter(span => span.name.startsWith("activity "))) {
        expect([parent.spanId, child.spanId]).toContain(span.parentSpanId);
        expect(span.traceId).toBe(parent.traceId);
      }
    } finally { await spanExporter.close(); }
  }, 120_000);

  it("preserves a later mission's API parent and links a background child to its source and supervisor", async () => {
    requests.length = 0;
    const spanExporter = exporter();
    const taskQueue = `missions-${randomUUID()}`;
    const workflowId = `workflow:${randomUUID()}`;
    const originalTrace = "1".repeat(32);
    const laterTrace = "2".repeat(32);
    const originalSpan = "3".repeat(16);
    const laterSpan = "4".repeat(16);
    const original = { traceparent: `00-${originalTrace}-${originalSpan}-01` };
    const later = { traceparent: `00-${laterTrace}-${laterSpan}-01` };
    const background = { ...later, traceId: "trace:bg-later", roomAgentContinuation: { sourceRunId: "run:later" } };
    const active = await worker(taskQueue, spanExporter);
    try {
      await active.runUntil(() => environment.client.workflow.execute("traceLaterMissions", { taskQueue, workflowId, args: [original, later, background] }));
      await spanExporter.flush();
      const root = spans().find(span => span.name === "workflow traceLaterMissions")!;
      const children = spans().filter(span => span.name === "workflow traceChild");
      const mission = children.find(span => attributes(span)["space.workflow_id"] === `${workflowId}:later`)!;
      const continuation = children.find(span => attributes(span)["space.workflow_id"] === `${workflowId}:background`)!;
      expect(root.traceId).toBe(originalTrace);
      expect(mission.traceId).toBe(laterTrace);
      expect(mission.parentSpanId).toBe(laterSpan);
      expect(mission.links).toContainEqual({ traceId: originalTrace, spanId: root.spanId });
      expect(continuation.traceId).not.toBe(laterTrace);
      expect(continuation.links).toEqual(expect.arrayContaining([
        { traceId: laterTrace, spanId: laterSpan }, { traceId: originalTrace, spanId: root.spanId }
      ]));
    } finally { await spanExporter.close(); }
  }, 120_000);
});
