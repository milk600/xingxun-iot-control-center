"use client";

import { useEffect, useRef, useState } from "react";
import { useNavigationTransition } from "@/app/features/transitions/NavigationTransition";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import { PAGE_PATHS, type AgentActionDispatchDetail } from "@/app/lib/ai/contracts";
import styles from "./AiPageFocusManager.module.css";

const HIGHLIGHT_DURATION_MS = 5_200;
const TARGET_RETRY_DELAYS_MS = [0, 80, 200, 480, 850, 1_250] as const;

const REGION_ALIASES: Readonly<Record<string, string>> = {
  "metric-posture": "indicator-posture",
  correlation: "correlation-matrix",
  events: "event-timeline",
};

function findRegion(region: string) {
  const canonicalRegion = REGION_ALIASES[region] ?? region;
  const candidates = [...document.querySelectorAll<HTMLElement>("[data-ai-region]")]
    .filter((element) => element.dataset.aiRegion === canonicalRegion);
  return candidates.find((element) => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && element.getClientRects().length > 0;
  }) ?? null;
}

function regionLabel(element: HTMLElement, region: string) {
  return element.dataset.aiLabel
    || element.getAttribute("aria-label")
    || element.querySelector("h1, h2, h3, [role='heading']")?.textContent?.trim()
    || region;
}

export function AiPageFocusManager() {
  const navigation = useNavigationTransition();
  const activeTargetRef = useRef<HTMLElement | null>(null);
  const clearTimerRef = useRef<number | null>(null);
  const retryTimersRef = useRef<number[]>([]);
  const scrollFrameRef = useRef<number | null>(null);
  const backCleanupRef = useRef<(() => void) | null>(null);
  const requestSequenceRef = useRef(0);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const clearHighlight = () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      activeTargetRef.current?.classList.remove(styles.focusTarget);
      activeTargetRef.current?.removeAttribute("data-ai-focus-active");
      activeTargetRef.current = null;
    };

    const clearRetries = () => {
      retryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      retryTimersRef.current = [];
    };

    const clearScrollWait = () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };

    const highlight = (
      target: HTMLElement,
      region: string,
      action: AgentActionDispatchDetail,
    ) => {
      clearRetries();
      clearHighlight();
      activeTargetRef.current = target;
      target.classList.remove(styles.focusTarget);
      // Restart the pulse when the same region is requested repeatedly.
      void target.offsetWidth;
      target.classList.add(styles.focusTarget);
      target.setAttribute("data-ai-focus-active", "true");
      target.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
        inline: "nearest",
      });
      const label = regionLabel(target, region);
      setAnnouncement("");
      window.requestAnimationFrame(() => setAnnouncement(`已定位到${label}`));
      clearTimerRef.current = window.setTimeout(clearHighlight, HIGHLIGHT_DURATION_MS);
      reportActionSuccess(action, `已定位并高亮“${label}”。`);
    };

    const waitForScroll = (
      action: AgentActionDispatchDetail,
      expectedTop: number | null,
    ) => {
      clearScrollWait();
      const startedAt = performance.now();
      let lastTop = window.scrollY;
      let stableFrames = 0;
      const check = () => {
        const currentTop = window.scrollY;
        const targetReached = expectedTop === null || Math.abs(currentTop - expectedTop) <= 2;
        if (Math.abs(currentTop - lastTop) <= 1) stableFrames += 1;
        else stableFrames = 0;
        lastTop = currentTop;
        if ((targetReached && stableFrames >= 2) || (expectedTop === null && stableFrames >= 4)) {
          scrollFrameRef.current = null;
          reportActionSuccess(action, "页面已滚动到目标位置。");
          return;
        }
        if (performance.now() - startedAt >= 2_800) {
          scrollFrameRef.current = null;
          reportActionError(action, "页面滚动未能到达目标位置。");
          return;
        }
        scrollFrameRef.current = window.requestAnimationFrame(check);
      };
      scrollFrameRef.current = window.requestAnimationFrame(check);
    };

    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (!action) return;

      if (action.name === "ui.navigate") {
        const expectedPath = PAGE_PATHS[action.arguments.page];
        if (window.location.pathname === expectedPath) {
          reportActionSuccess(action, `已打开${action.arguments.page}页面。`);
        } else {
          reportActionError(
            action,
            `目标页面未打开：期望 ${expectedPath}，当前为 ${window.location.pathname}。`,
          );
        }
        return;
      }

      if (action.name === "ui.back") {
        clearRetries();
        clearHighlight();
        clearScrollWait();
        backCleanupRef.current?.();
        let completed = false;
        const finish = (navigationEvent: Event) => {
          if (completed) return;
          completed = true;
          backCleanupRef.current?.();
          backCleanupRef.current = null;
          const destination = (navigationEvent as CustomEvent<{ to?: string }>).detail?.to;
          reportActionSuccess(
            action,
            destination ? `已返回 ${destination}。` : "已返回上一页。",
          );
        };
        window.addEventListener("xingxun:navigation-end", finish);
        backCleanupRef.current = () => window.removeEventListener("xingxun:navigation-end", finish);
        navigation.back("/");
        return;
      }

      if (action.name === "ui.scroll") {
        const direction = action.arguments.direction;
        clearRetries();
        clearHighlight();
        clearScrollWait();
        const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth";
        if (direction === "top" || direction === "bottom") {
          const expectedTop = direction === "top"
            ? 0
            : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo({ top: expectedTop, behavior });
          waitForScroll(action, expectedTop);
          return;
        }
        const viewportFactor = action.arguments.amount === "small" ? 0.38 : 0.82;
        const distance = Math.max(220, window.innerHeight * viewportFactor);
        const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const expectedTop = Math.max(
          0,
          Math.min(maxTop, window.scrollY + (direction === "up" ? -distance : distance)),
        );
        window.scrollBy({
          top: direction === "up" ? -distance : distance,
          behavior,
        });
        waitForScroll(action, expectedTop);
        return;
      }

      if (action.name !== "ui.focus_region") return;
      const region = action.arguments.region;
      if (!region) {
        reportActionError(action, "聚焦区域名称为空。");
        return;
      }

      clearRetries();
      const sequence = ++requestSequenceRef.current;
      TARGET_RETRY_DELAYS_MS.forEach((delay, index) => {
        const timer = window.setTimeout(() => {
          if (sequence !== requestSequenceRef.current) return;
          const target = findRegion(region);
          if (target) {
            highlight(target, region, action);
            return;
          }
          if (index === TARGET_RETRY_DELAYS_MS.length - 1) {
            clearRetries();
            reportActionError(action, `页面上未找到可见区域“${region}”。`);
          }
        }, delay);
        retryTimersRef.current.push(timer);
      });
    };

    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver([
      "ui.navigate",
      "ui.back",
      "ui.focus_region",
      "ui.scroll",
    ]);
    return () => {
      unregisterReceiver();
      requestSequenceRef.current += 1;
      clearRetries();
      clearScrollWait();
      backCleanupRef.current?.();
      backCleanupRef.current = null;
      clearHighlight();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [navigation]);

  return (
    <span className={styles.liveRegion} role="status" aria-live="polite">
      {announcement}
    </span>
  );
}
