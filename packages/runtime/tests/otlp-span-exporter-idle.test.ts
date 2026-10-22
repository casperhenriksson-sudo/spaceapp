import { expect, it, vi } from "vitest";
import { createOtlpSpanExporter, type ServerSpan } from "../src/otlp-span-exporter.js";

it("exports a later span after an empty idle flush instead of retaining a resolved in-flight promise", async () => {
  const send = vi.fn(async () => ({ ok: true }));
  const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "idle-regression", fetch: send, flushIntervalMs: 60_000 });
  const span: ServerSpan = { traceId: "1".repeat(32), spanId: "2".repeat(16), parentSpanId: null, name: "fixture",
    startTimeUnixNano: 1n, endTimeUnixNano: 2n, attributes: {}, error: false };
  try {
    await exporter.flush();
    exporter.record(span);
    await exporter.flush();
    expect(send).toHaveBeenCalledOnce();
    expect(exporter.stats()).toEqual({ exported: 1, dropped: 0, failed: 0 });
    await exporter.flush();
    exporter.record(span);
    await exporter.flush();
    expect(send).toHaveBeenCalledTimes(2);
  } finally { await exporter.close(); }
});
