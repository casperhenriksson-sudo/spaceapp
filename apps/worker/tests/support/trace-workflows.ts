import { ApplicationFailure, continueAsNew, executeChild, proxyActivities, sleep, uuid4, workflowInfo } from "@temporalio/workflow";
export { codexAppServerTurnWorkflow } from "../../src/workflows.js";
export { memoryMaintenanceWorkflow, memoryConsolidationWorkflow } from "../../src/memory-maintenance-workflows.js";

const activities = proxyActivities<{ tracedAttempt(): Promise<string> }>({
  startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 2, initialInterval: "1 millisecond" }
});
export interface TraceInput {
  traceparent?: string;
  roomId?: string;
  prompt?: string;
  traceId?: string;
  roomAgentContinuation?: { sourceRunId: string };
}
export async function traceChild(input: TraceInput): Promise<string> {
  await activities.tracedAttempt();
  return input.roomId ?? "done";
}
export async function traceWorkflow(input: TraceInput): Promise<string> {
  await activities.tracedAttempt();
  return executeChild(traceChild, { args: [input], workflowId: `${workflowInfo().workflowId}:child` });
}
export async function traceContinue(input: TraceInput, generation = 0): Promise<string> {
  await activities.tracedAttempt();
  if (generation === 0) return continueAsNew<typeof traceContinue>(input, 1);
  return "continued";
}
export async function traceRandom(): Promise<string> {
  const id = uuid4();
  // The random id affects an emitted command, making replay detect RNG shifts.
  return executeChild(traceChild, { args: [{}], workflowId: id });
}
export async function traceFailure(): Promise<never> {
  throw ApplicationFailure.create({ message: "PRIVATE PROMPT sk-live-failure /private/file", type: "TOOL_UNAVAILABLE", nonRetryable: true });
}
export async function traceCancelled(): Promise<void> {
  await sleep("1 hour");
}
export async function traceLaterMissions(_original: TraceInput, later: TraceInput, background: TraceInput): Promise<void> {
  await executeChild(traceChild, { args: [later], workflowId: `${workflowInfo().workflowId}:later` });
  await executeChild(traceChild, { args: [background], workflowId: `${workflowInfo().workflowId}:background` });
}
