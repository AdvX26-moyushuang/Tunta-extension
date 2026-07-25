import { useCallback, useEffect, useRef, useState } from "react";

export interface ToastState {
  id: number;
  message: string;
}

export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((message: string) => {
    window.clearTimeout(timer.current);
    setToast({ id: Date.now(), message });
    timer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { toast, show };
}

export function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <div key={toast.id} className="toast" role="status">
      {toast.message}
    </div>
  );
}
