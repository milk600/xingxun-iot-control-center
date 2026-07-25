"use client";

import { useEffect, useRef } from "react";

interface AndroidBackEntry {
  priority: number;
  sequence: number;
  run: () => void;
}

const entries = new Map<symbol, AndroidBackEntry>();
let nextSequence = 0;
let listening = false;

function handleAndroidBack(event: Event) {
  if (event.defaultPrevented || entries.size === 0) return;
  const entry = [...entries.values()].sort(
    (left, right) => right.priority - left.priority || right.sequence - left.sequence,
  )[0];
  if (!entry) return;
  event.preventDefault();
  entry.run();
}

function startListening() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("xingxun:android-back", handleAndroidBack);
  listening = true;
}

function stopListeningIfIdle() {
  if (!listening || entries.size > 0 || typeof window === "undefined") return;
  window.removeEventListener("xingxun:android-back", handleAndroidBack);
  listening = false;
}

/**
 * Registers one currently visible Android back target.
 *
 * Higher-priority transient controls (for example a select menu) close before
 * their containing sheet or page. Within the same priority, the most recently
 * opened target wins.
 */
export function useAndroidBack(
  enabled: boolean,
  handler: () => void,
  priority = 0,
) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;
    const id = Symbol("android-back");
    entries.set(id, {
      priority,
      sequence: ++nextSequence,
      run: () => handlerRef.current(),
    });
    startListening();
    return () => {
      entries.delete(id);
      stopListeningIfIdle();
    };
  }, [enabled, priority]);
}
