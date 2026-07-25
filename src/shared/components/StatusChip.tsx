import type { CaptureStatus } from "@/shared/api/contracts";

const LABELS: Record<CaptureStatus, string> = {
  idle: "等待中",
  fetching: "抓取中",
  parsing: "解析中",
  done: "已完成",
  failed: "失败",
};

/** README 要求的五态可见性：idle / fetching / parsing / done / failed。 */
export function StatusChip({ status }: { status: CaptureStatus }) {
  return (
    <span className="status-chip" data-status={status}>
      {LABELS[status]}
    </span>
  );
}
