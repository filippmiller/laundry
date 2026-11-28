import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The state of a control lives in the URL, not in the component.
 *
 * A tab strip, a queue filter or an analysis period used to live in `useState` only: a reload
 * reset it, the Back button left the application entirely, and the state could not be shared
 * with a colleague. The URL is the honest place for it — the workspace already lives in the
 * hash, the query string completes the description of what the user is looking at.
 *
 * The state is never stored in `localStorage`/`sessionStorage`: the project uses storage only
 * for the courier device id and the scan-queue migration marker, and URL state is shareable in a
 * way storage state is not.
 */
export type UrlStateOptions = {
  /**
   * `push` (default) adds a history entry so the Back button returns to the previous view;
   * `replace` overwrites the current entry. Use `replace` for filters that change constantly
   * (a period selector) and `push` for tabs that change the view.
   */
  push?: boolean;
};

function readParam(search: string, key: string): string | null {
  const params = new URLSearchParams(search);
  return params.get(key);
}

function writeParam(key: string, value: string, push: boolean): void {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  const method = push ? "pushState" : "replaceState";
  window.history[method](window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function useUrlState<T extends string>(
  key: string,
  defaultValue: T,
  options: UrlStateOptions = {},
): [T, (value: T) => void] {
  const push = options.push ?? true;
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    const fromUrl = readParam(window.location.search, key);
    return (fromUrl ?? defaultValue) as T;
  });
  // The key and the default may change when the workspace changes; the URL stays the source.
  const keyRef = useRef(key);
  const defaultRef = useRef(defaultValue);
  keyRef.current = key;
  defaultRef.current = defaultValue;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePopState = () => {
      const fromUrl = readParam(window.location.search, keyRef.current);
      setValue((fromUrl ?? defaultRef.current) as T);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      if (typeof window === "undefined") return;
      writeParam(keyRef.current, next, push);
    },
    [push],
  );

  return [value, update];
}
