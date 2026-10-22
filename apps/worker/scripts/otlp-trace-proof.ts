/** Local-only visual proof: real HTTP request + real Temporal + stub provider. No AI/network provider calls. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import { createHttpObservability } from "../../api/src/observability.js";
import { requestTraceContexts, traceContextForRawRequest, withTurnTraceparent } from "../../api/src/trace-context.js";
import { workerTracingOptions } from "../src/workflow-trace-sinks.js";

const endpoint = process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
const target = new URL(endpoint);
if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password || target.search || target.hash) {
  throw new Error("This proof script accepts only a local HTTP collector without credentials.");
}
const apiSpans = createOtlpSpanExporter({ endpoint, serviceName: "space-api" });
const workerSpans = createOtlpSpanExporter({ endpoint, serviceName: "space-worker" });
const observer = createHttpObservability({ serviceName: "space-api", spanExporter: apiSpans });
const app = Fastify();
let environment: TestWorkflowEnvironment | undefined;
try {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `trace-proof-${randomUUID()}`;
  const workflowId = `workflow:trace-proof-${randomUUID()}`;
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace, taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), ...workerTracingOptions(workerSpans),
    activities: { runCodexAppServerTurn: async () => ({ status: "COMPLETED", runId: "agent_run:trace-proof" }) } });
  app.addHook("onRequest", async request => observer.onRequest(request));
  app.addHook("onResponse", async (request, reply) => observer.onResponse(request, reply));
  app.post("/trace-proof", async request => {
    const context = traceContextForRawRequest(request.raw);
    requestTraceContexts.remember(request.id, context);
    const input = withTurnTraceparent({ roomId: "room:trace-proof", paneId: "pane:trace-proof", prompt: "Local tracing fixture",
      artifactIds: [], traceId: request.id });
    const result = await environment!.client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue, workflowId, args: [input] });
    return { traceId: context.w3cTraceId, workflowId, result };
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await worker.runUntil(async () => {
    const response = await fetch(`${address}/trace-proof`, { method: "POST" });
    if (!response.ok) throw new Error(`Proof request failed: ${response.status}`);
    console.log(JSON.stringify(await response.json()));
  });
  await Promise.all([apiSpans.flush(), workerSpans.flush()]);
  if (apiSpans.stats().exported !== 1 || workerSpans.stats().exported !== 2) throw new Error("Expected one real API span, one workflow span and one activity span.");
  if (apiSpans.stats().failed || workerSpans.stats().failed) throw new Error("The local collector did not accept every proof span.");
  console.log(JSON.stringify({ api: apiSpans.stats(), worker: workerSpans.stats(), collector: endpoint }));
} finally {
  await app.close();
  observer.close();
  await Promise.all([apiSpans.close(), workerSpans.close()]);
  await environment?.teardown();
}
