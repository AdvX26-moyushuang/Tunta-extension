import { useEffect, useRef, useState } from "react";
import { getApi } from "@/shared/api";
import type { CaptureItem } from "@/shared/api/contracts";

const POLL_INTERVAL_MS = 1500;
const TERMINAL = new Set(["done", "failed"]);

/**
 * 提交收藏后轮询处理状态，直到 done / failed。
 * 状态可见性（REQ-009）：等待过程中用户始终知道系统正在做什么。
 */
export function useCaptureTracking() {
  const [tracked, setTracked] = useState<CaptureItem | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function schedule(captureId: string) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void poll(captureId), POLL_INTERVAL_MS);
  }

  async function poll(captureId: string) {
    try {
      const captures = await getApi().listCaptures();
      const current = captures.find((item) => item.captureId === captureId);
      if (!current) return;
      setTracked({ ...current });
      if (!TERMINAL.has(current.status)) schedule(captureId);
    } catch {
      // backend 暂时不可达时停止轮询，保留当前展示状态
    }
  }

  function track(capture: CaptureItem) {
    setTracked(capture);
    if (!TERMINAL.has(capture.status)) schedule(capture.captureId);
  }

  function clear() {
    window.clearTimeout(timer.current);
    setTracked(null);
  }

  return { tracked, track, clear };
}
