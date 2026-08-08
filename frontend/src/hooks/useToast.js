import { useCallback, useState } from "react";

let idCounter = 0;

export function useToast() {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, type = "info") => {
    const id = ++idCounter;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  return { toasts, push };
}
