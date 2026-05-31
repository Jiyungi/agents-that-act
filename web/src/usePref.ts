/* usePref — localStorage-backed preference state for the demo Tweaks panel. */
import { useEffect, useState } from "react";

export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem("pg." + key);
      return s == null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("pg." + key, JSON.stringify(v));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [key, v]);
  return [v, setV];
}
