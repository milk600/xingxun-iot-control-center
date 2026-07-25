"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  DEFAULT_MOTION_SPEED_PERCENT,
  LEGACY_UI_PREFERENCES_KEY,
  MOTION_SPEED_PREVIEW_EVENT,
  UI_PREFERENCES_EVENT,
  UI_PREFERENCES_KEY,
  applyMotionSpeedToDocument,
  getScaledMotionDurationMs,
  normalizeMotionSpeedPercent,
  readPreferences,
} from "@/app/lib/ui-preferences";

type NavigationDirection = "forward" | "back" | "drill-in";

interface NavigationTransitionContextValue {
  navigate: (href: string) => void;
  back: (fallback?: string) => void;
  isTransitioning: boolean;
}

interface StoredHistoryEntry {
  index: number;
  path: string;
  source: string | null;
  scrollY: number;
  timestamp: number;
}

interface NavigationHistoryState extends StoredHistoryEntry {
  internal: true;
}

interface PendingNavigation {
  index: number;
  source: string | null;
  target: string;
  mode: "push" | "replace" | "pop";
  restoreScroll: boolean;
}

type TransitionLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  href: string;
  children: ReactNode;
};

const HISTORY_STATE_KEY = "__xingxunNavigation";
const HISTORY_STORAGE_KEY = "xingxun:navigation-history";
const LIVE_EXIT_DURATION_MS = 96;
const LIVE_ENTER_DURATION_MS = 188;
const LIVE_EASING = "cubic-bezier(.16, 1, .3, 1)";
const ROUTE_ORDER = [
  "/",
  "/vehicle",
  "/monitoring",
  "/integrations",
  "/settings",
] as const;

const NavigationTransitionContext =
  createContext<NavigationTransitionContextValue | null>(null);

function currentLocationPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function pathnameFromHref(href: string) {
  return new URL(href, window.location.href).pathname;
}

function getNavigationDirection(
  fromHref: string,
  toHref: string,
): NavigationDirection {
  const from = pathnameFromHref(fromHref);
  const to = pathnameFromHref(toHref);

  if (to === "/digital-twin" && from !== "/digital-twin") {
    return "drill-in";
  }
  if (from === "/digital-twin" && to !== "/digital-twin") {
    return "back";
  }

  const fromIndex = ROUTE_ORDER.indexOf(from as (typeof ROUTE_ORDER)[number]);
  const toIndex = ROUTE_ORDER.indexOf(to as (typeof ROUTE_ORDER)[number]);
  if (fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex) {
    return "back";
  }
  return "forward";
}

function readNavigationState(state: unknown): NavigationHistoryState | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[HISTORY_STATE_KEY];
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<NavigationHistoryState>;
  if (
    candidate.internal !== true ||
    typeof candidate.index !== "number" ||
    typeof candidate.path !== "string" ||
    typeof candidate.scrollY !== "number"
  ) {
    return null;
  }
  return candidate as NavigationHistoryState;
}

function readStoredHistory(): Record<string, StoredHistoryEntry> {
  try {
    const value = window.sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, StoredHistoryEntry>)
      : {};
  } catch {
    return {};
  }
}

function persistHistoryEntry(entry: StoredHistoryEntry) {
  try {
    const entries = readStoredHistory();
    entries[String(entry.index)] = entry;

    // A session only needs a compact local trail. Keeping the newest 40 entries
    // prevents long-running dashboards from growing storage without bound.
    const indexes = Object.keys(entries)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    for (const index of indexes.slice(40)) delete entries[String(index)];

    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Private browsing or a locked-down WebView may reject sessionStorage.
  }
}

function replaceNavigationState(entry: NavigationHistoryState) {
  const existing =
    window.history.state && typeof window.history.state === "object"
      ? window.history.state
      : {};
  window.history.replaceState(
    { ...existing, [HISTORY_STATE_KEY]: entry },
    "",
    window.location.href,
  );
}

function dispatchNavigationStart(
  from: string,
  to: string,
  direction: NavigationDirection,
) {
  window.dispatchEvent(
    new CustomEvent("xingxun:navigation-start", {
      detail: { from, to, direction },
    }),
  );
}

function dispatchNavigationEnd(
  from: string,
  to: string,
  direction: NavigationDirection,
) {
  window.dispatchEvent(
    new CustomEvent("xingxun:navigation-end", {
      detail: { from, to, direction },
    }),
  );
}

interface LiveTransitionElements {
  main: HTMLElement | null;
  title: HTMLElement | null;
  sidebar: HTMLElement | null;
  topbar: HTMLElement | null;
  mobileNav: HTMLElement | null;
  curtain: HTMLElement | null;
}

interface AnimationSpec {
  element: HTMLElement | null;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

function getLiveTransitionElements(): LiveTransitionElements {
  const shell = document.querySelector<HTMLElement>(
    ".navigation-transition-root > :first-child",
  );
  const stage = shell?.querySelector<HTMLElement>(":scope > div") ?? null;
  const topbar =
    stage?.querySelector<HTMLElement>(":scope > header:first-child") ?? null;

  return {
    main: stage?.querySelector<HTMLElement>(":scope > main") ?? null,
    title: topbar?.querySelector<HTMLElement>("h1") ?? null,
    sidebar:
      shell?.querySelector<HTMLElement>(":scope > aside:first-of-type") ?? null,
    topbar,
    mobileNav: shell?.querySelector<HTMLElement>(":scope > nav") ?? null,
    curtain: document.querySelector<HTMLElement>(
      ".navigation-transition-curtain",
    ),
  };
}

function isVisibleAnimationTarget(
  element: HTMLElement | null,
): element is HTMLElement {
  if (!element?.isConnected) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

async function playAnimations(
  specs: AnimationSpec[],
  activeAnimations: Set<Animation>,
  retainFinalState = false,
) {
  const animations = specs.flatMap(({ element, keyframes, options }) => {
    if (!isVisibleAnimationTarget(element)) return [];
    const animation = element.animate(keyframes, options);
    activeAnimations.add(animation);
    return [animation];
  });

  await Promise.all(
    animations.map((animation) =>
      animation.finished.catch(() => undefined),
    ),
  );

  if (!retainFinalState) {
    animations.forEach((animation) => {
      activeAnimations.delete(animation);
      animation.cancel();
    });
  }

  return animations;
}

function releaseAnimations(
  animations: Animation[],
  activeAnimations: Set<Animation>,
) {
  animations.forEach((animation) => {
    activeAnimations.delete(animation);
    animation.cancel();
  });
}

function contentExitSpecs(
  elements: LiveTransitionElements,
  direction: NavigationDirection,
  motionSpeedPercent: number,
): AnimationSpec[] {
  const offset = direction === "back" ? 7 : -7;
  const options: KeyframeAnimationOptions = {
    duration: getScaledMotionDurationMs(LIVE_EXIT_DURATION_MS, motionSpeedPercent),
    easing: LIVE_EASING,
    fill: "both",
  };

  return [
    {
      element: elements.main,
      keyframes: [
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
        { opacity: 0, transform: `translate3d(${offset}px, 0, 0)` },
      ],
      options,
    },
    {
      element: elements.title,
      keyframes: [
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
        {
          opacity: 0,
          transform: `translate3d(${Math.round(offset * 0.7)}px, 0, 0)`,
        },
      ],
      options,
    },
  ];
}

function contentEnterSpecs(
  elements: LiveTransitionElements,
  direction: NavigationDirection,
  motionSpeedPercent: number,
): AnimationSpec[] {
  const offset = direction === "back" ? -14 : 14;
  const options: KeyframeAnimationOptions = {
    duration: getScaledMotionDurationMs(LIVE_ENTER_DURATION_MS, motionSpeedPercent),
    easing: LIVE_EASING,
    fill: "both",
  };

  return [
    {
      element: elements.main,
      keyframes: [
        { opacity: 0, transform: `translate3d(${offset}px, 0, 0)` },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      options,
    },
    {
      element: elements.title,
      keyframes: [
        {
          opacity: 0,
          transform: `translate3d(${Math.round(offset * 0.7)}px, 0, 0)`,
        },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      options,
    },
  ];
}

function shellExitSpecs(
  elements: LiveTransitionElements,
  motionSpeedPercent: number,
): AnimationSpec[] {
  const options: KeyframeAnimationOptions = {
    duration: getScaledMotionDurationMs(LIVE_EXIT_DURATION_MS, motionSpeedPercent),
    easing: LIVE_EASING,
    fill: "both",
  };

  return [
    {
      element: elements.sidebar,
      keyframes: [
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
        { opacity: 0, transform: "translate3d(-10px, 0, 0)" },
      ],
      options,
    },
    {
      element: elements.topbar,
      keyframes: [
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
        { opacity: 0, transform: "translate3d(0, -6px, 0)" },
      ],
      options,
    },
    {
      element: elements.mobileNav,
      keyframes: [
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
        { opacity: 0, transform: "translate3d(0, 8px, 0)" },
      ],
      options,
    },
    {
      element: elements.curtain,
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
      options,
    },
  ];
}

function shellEnterSpecs(
  elements: LiveTransitionElements,
  motionSpeedPercent: number,
): AnimationSpec[] {
  const options: KeyframeAnimationOptions = {
    duration: getScaledMotionDurationMs(LIVE_ENTER_DURATION_MS, motionSpeedPercent),
    easing: LIVE_EASING,
    fill: "both",
  };

  return [
    {
      element: elements.sidebar,
      keyframes: [
        { opacity: 0, transform: "translate3d(-12px, 0, 0)" },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      options,
    },
    {
      element: elements.topbar,
      keyframes: [
        { opacity: 0, transform: "translate3d(0, -8px, 0)" },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      options,
    },
    {
      element: elements.mobileNav,
      keyframes: [
        { opacity: 0, transform: "translate3d(0, 10px, 0)" },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      options,
    },
    {
      element: elements.curtain,
      keyframes: [{ opacity: 1 }, { opacity: 0 }],
      options,
    },
  ];
}

export function NavigationTransitionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isTransitioning, setIsTransitioning] = useState(false);
  const mountedRef = useRef(false);
  const transitioningRef = useRef(false);
  const historyIndexRef = useRef(0);
  const previousPathnameRef = useRef(pathname);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const routeResolverRef = useRef<(() => void) | null>(null);
  const transitionSequenceRef = useRef(0);
  const activeAnimationsRef = useRef<Set<Animation>>(new Set());
  const motionSpeedPercentRef = useRef(DEFAULT_MOTION_SPEED_PERCENT);

  useEffect(() => {
    const applySpeed = (value: unknown) => {
      const nextSpeed = applyMotionSpeedToDocument(value);
      motionSpeedPercentRef.current = nextSpeed;
    };
    const applyStoredPreferences = () => {
      applySpeed(readPreferences().motionSpeedPercent);
    };
    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<{ motionSpeedPercent?: unknown }>).detail;
      applySpeed(normalizeMotionSpeedPercent(detail?.motionSpeedPercent));
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === UI_PREFERENCES_KEY
        || event.key === LEGACY_UI_PREFERENCES_KEY
        || event.key === null
      ) {
        applyStoredPreferences();
      }
    };

    applyStoredPreferences();
    window.addEventListener(UI_PREFERENCES_EVENT, applyStoredPreferences);
    window.addEventListener(MOTION_SPEED_PREVIEW_EVENT, handlePreview);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(UI_PREFERENCES_EVENT, applyStoredPreferences);
      window.removeEventListener(MOTION_SPEED_PREVIEW_EVENT, handlePreview);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const recordCurrentEntry = useCallback(() => {
    const path = currentLocationPath();
    const existing = readNavigationState(window.history.state);
    const entry: NavigationHistoryState = {
      internal: true,
      index: existing?.index ?? historyIndexRef.current,
      path,
      source: existing?.source ?? null,
      scrollY: window.scrollY,
      timestamp: Date.now(),
    };
    historyIndexRef.current = entry.index;
    replaceNavigationState(entry);
    persistHistoryEntry(entry);
    return entry;
  }, []);

  const waitForRouteCommit = useCallback((targetPathname?: string) => {
    return new Promise<void>((resolve) => {
      let settled = false;
      let safetyTimer: number | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (safetyTimer !== null) window.clearTimeout(safetyTimer);
        routeResolverRef.current = null;
        resolve();
      };

      routeResolverRef.current = finish;
      safetyTimer = window.setTimeout(finish, 1_200);

      if (targetPathname && targetPathname === previousPathnameRef.current) {
        window.queueMicrotask(finish);
      }
    });
  }, []);

  const runTransition = useCallback(
    (
      update: () => void | Promise<void>,
      direction: NavigationDirection,
      from: string,
      to: string,
    ) => {
      if (transitioningRef.current) return;

      const sequence = ++transitionSequenceRef.current;
      const root = document.documentElement;
      let completed = false;
      let removeVisibilityGuard: (() => void) | null = null;
      const cancelActiveAnimations = () => {
        activeAnimationsRef.current.forEach((animation) => animation.cancel());
        activeAnimationsRef.current.clear();
      };
      transitioningRef.current = true;
      setIsTransitioning(true);
      root.dataset.navigationDirection = direction;
      root.dataset.navigationTransition = "running";
      dispatchNavigationStart(from, to, direction);

      const complete = () => {
        if (transitionSequenceRef.current !== sequence || completed) return;
        completed = true;
        removeVisibilityGuard?.();
        removeVisibilityGuard = null;
        cancelActiveAnimations();
        transitioningRef.current = false;
        setIsTransitioning(false);
        delete root.dataset.navigationDirection;
        delete root.dataset.navigationTransition;
        delete root.dataset.navigationFallback;
        delete root.dataset.navigationPhase;
        delete root.dataset.navigationSurface;
        dispatchNavigationEnd(from, to, direction);
      };

      const touchesWebGlWorkspace =
        pathnameFromHref(from) === "/digital-twin" ||
        pathnameFromHref(to) === "/digital-twin";
      const motionSpeedPercent = motionSpeedPercentRef.current;
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      // Background tabs suspend compositor work and reduced-motion users should
      // not wait for presentation-only phases. Commit immediately in both cases.
      if (reducedMotion || document.hidden) {
        void Promise.resolve(update()).then(complete, complete);
        return;
      }

      // Keep the router commit between two Animation.finished-driven phases.
      // Ordinary routes animate the content surface; digital-twin boundaries
      // animate only the lightweight shell and never touch or snapshot canvas.
      root.dataset.navigationFallback = "true";
      root.dataset.navigationPhase = "exit";
      root.dataset.navigationSurface = touchesWebGlWorkspace
        ? "shell"
        : "content";

      const handleVisibilityChange = () => {
        if (!document.hidden) return;
        cancelActiveAnimations();
        routeResolverRef.current?.();
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      removeVisibilityGuard = () => {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      };

      const performLiveTransition = async () => {
        const exitElements = getLiveTransitionElements();
        const exitSpecs = touchesWebGlWorkspace
          ? shellExitSpecs(exitElements, motionSpeedPercent)
          : contentExitSpecs(exitElements, direction, motionSpeedPercent);
        const exitAnimations = await playAnimations(
          exitSpecs,
          activeAnimationsRef.current,
          true,
        );

        if (completed || transitionSequenceRef.current !== sequence) return;
        root.dataset.navigationPhase = "commit";
        await update();

        if (
          completed ||
          transitionSequenceRef.current !== sequence ||
          document.hidden
        ) {
          return;
        }

        root.dataset.navigationPhase = "enter";
        const enterElements = getLiveTransitionElements();
        const enterSpecs = touchesWebGlWorkspace
          ? shellEnterSpecs(enterElements, motionSpeedPercent)
          : contentEnterSpecs(enterElements, direction, motionSpeedPercent);
        // Keep the outgoing surface at its final keyframe across the async
        // route commit, then replace that held state with the incoming
        // animation in the same task so no intermediate flash can paint.
        releaseAnimations(exitAnimations, activeAnimationsRef.current);
        await playAnimations(enterSpecs, activeAnimationsRef.current);
        root.dataset.navigationPhase = "active";
      };

      void performLiveTransition().then(complete, complete);
    },
    [],
  );

  const navigateInternal = useCallback(
    (href: string, mode: "push" | "replace" = "push", forcedDirection?: NavigationDirection) => {
      if (transitioningRef.current) return;

      const targetUrl = new URL(href, window.location.href);
      if (targetUrl.origin !== window.location.origin) {
        window.location.assign(targetUrl.href);
        return;
      }

      const target = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
      const from = currentLocationPath();
      if (target === from) return;

      const currentEntry = recordCurrentEntry();
      const direction =
        forcedDirection ?? getNavigationDirection(currentEntry.path, target);
      const nextIndex =
        mode === "replace" ? currentEntry.index : currentEntry.index + 1;

      pendingNavigationRef.current = {
        index: nextIndex,
        source: currentEntry.path,
        target,
        mode,
        restoreScroll: false,
      };

      runTransition(
        () => {
          const committed = waitForRouteCommit(targetUrl.pathname);
          if (mode === "replace") router.replace(target);
          else router.push(target);
          return committed;
        },
        direction,
        from,
        target,
      );
    },
    [recordCurrentEntry, router, runTransition, waitForRouteCommit],
  );

  const navigate = useCallback(
    (href: string) => navigateInternal(href),
    [navigateInternal],
  );

  const back = useCallback(
    (fallback = "/") => {
      if (transitioningRef.current) return;

      const currentEntry = recordCurrentEntry();
      const entries = readStoredHistory();
      const previousEntry = entries[String(currentEntry.index - 1)];

      if (currentEntry.index > 0 && previousEntry) {
        pendingNavigationRef.current = {
          index: previousEntry.index,
          source: previousEntry.source,
          target: previousEntry.path,
          mode: "pop",
          restoreScroll: true,
        };
        runTransition(
          () => {
            const committed = waitForRouteCommit(
              pathnameFromHref(previousEntry.path),
            );
            window.history.back();
            return committed;
          },
          "back",
          currentEntry.path,
          previousEntry.path,
        );
        return;
      }

      navigateInternal(fallback, "replace", "back");
    },
    [navigateInternal, recordCurrentEntry, runTransition, waitForRouteCommit],
  );

  useEffect(() => {
    mountedRef.current = true;
    const activeAnimations = activeAnimationsRef.current;
    const existing = readNavigationState(window.history.state);
    const initial: NavigationHistoryState = existing ?? {
      internal: true,
      index: 0,
      path: currentLocationPath(),
      source: null,
      scrollY: window.scrollY,
      timestamp: Date.now(),
    };
    historyIndexRef.current = initial.index;
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    replaceNavigationState(initial);
    persistHistoryEntry(initial);

    const handleBeforeUnload = () => recordCurrentEntry();
    const handlePopState = (event: PopStateEvent) => {
      const state = readNavigationState(event.state);
      if (!state) return;

      const previousIndex = historyIndexRef.current;
      const previousEntry = readStoredHistory()[String(previousIndex)];
      const from = previousEntry?.path ?? previousPathnameRef.current;
      const direction: NavigationDirection =
        state.index < previousIndex ? "back" : "forward";
      historyIndexRef.current = state.index;

      // Programmatic back navigation is already inside runTransition. Native
      // browser Back/Forward reaches us here first, so wrap the pending React
      // commit in the exact same reversible transition and restore its scroll.
      if (transitioningRef.current) return;

      pendingNavigationRef.current = {
        index: state.index,
        source: state.source,
        target: state.path,
        mode: "pop",
        restoreScroll: true,
      };
      runTransition(
        () => waitForRouteCommit(pathnameFromHref(state.path)),
        direction,
        from,
        state.path,
      );
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handlePopState);
      window.history.scrollRestoration = previousScrollRestoration;
      activeAnimations.forEach((animation) => animation.cancel());
      activeAnimations.clear();
      routeResolverRef.current?.();
      routeResolverRef.current = null;
    };
  }, [recordCurrentEntry, runTransition, waitForRouteCommit]);

  useLayoutEffect(() => {
    if (!mountedRef.current || previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;

    const pending = pendingNavigationRef.current;
    const state = readNavigationState(window.history.state);
    const nextEntry: NavigationHistoryState = {
      internal: true,
      index: pending?.index ?? state?.index ?? historyIndexRef.current + 1,
      path: currentLocationPath(),
      source: pending?.source ?? state?.source ?? null,
      scrollY: pending?.restoreScroll
        ? readStoredHistory()[String(pending.index)]?.scrollY ?? 0
        : 0,
      timestamp: Date.now(),
    };

    historyIndexRef.current = nextEntry.index;
    replaceNavigationState(nextEntry);
    persistHistoryEntry(nextEntry);
    pendingNavigationRef.current = null;
    routeResolverRef.current?.();

    if (pending?.restoreScroll) {
      window.scrollTo({ top: nextEntry.scrollY, left: 0, behavior: "auto" });
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
  }, [pathname]);

  const value = useMemo<NavigationTransitionContextValue>(
    () => ({ navigate, back, isTransitioning }),
    [back, isTransitioning, navigate],
  );

  return (
    <NavigationTransitionContext.Provider value={value}>
      <div
        className="navigation-transition-root"
        data-navigation-busy={isTransitioning || undefined}
      >
        {children}
      </div>
      <div className="navigation-transition-curtain" aria-hidden="true" />
    </NavigationTransitionContext.Provider>
  );
}

export function useNavigationTransition() {
  const context = useContext(NavigationTransitionContext);
  if (!context) {
    throw new Error(
      "useNavigationTransition 必须在 NavigationTransitionProvider 内使用。",
    );
  }
  return context;
}

export const TransitionLink = forwardRef<HTMLAnchorElement, TransitionLinkProps>(
  function TransitionLink({ href, onClick, target, download, children, ...props }, ref) {
    const { navigate } = useNavigationTransition();

    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        target === "_blank" ||
        download !== undefined
      ) {
        return;
      }

      const targetUrl = new URL(href, window.location.href);
      if (targetUrl.origin !== window.location.origin) return;
      if (
        targetUrl.pathname === window.location.pathname &&
        targetUrl.search === window.location.search &&
        targetUrl.hash
      ) {
        return;
      }

      event.preventDefault();
      navigate(`${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);
    };

    return (
      <a
        {...props}
        ref={ref}
        href={href}
        target={target}
        download={download}
        onClick={handleClick}
      >
        {children}
      </a>
    );
  },
);
