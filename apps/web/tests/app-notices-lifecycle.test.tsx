import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppNotices } from "../src/features/app-notices/useAppNotices.js";

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("does not leave a debug toast callback running after its workspace unmounts", () => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { result, unmount } = renderHook(() => useAppNotices());
  const lateCompletion = result.current.showLiveDebug;
  act(() => result.current.showLiveDebug("Lifecycle fixture", "error"));
  expect(result.current.liveDebugToast?.message).toBe("Lifecycle fixture");
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  act(() => lateCompletion("A request settled after unmount", "error"));
  expect(vi.getTimerCount()).toBe(0);
});
