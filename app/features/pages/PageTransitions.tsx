"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import { getScaledMotionDurationMs } from "@/app/lib/ui-preferences";
import styles from "./Pages.module.css";

export type PanelDirection = "forward" | "back";

export interface SlidingTabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  markerLabel?: string;
}

export function useDirectionalSelection<T extends string>(
  order: readonly T[],
  initialValue: T,
) {
  const [value, setValue] = useState(initialValue);
  const [direction, setDirection] = useState<PanelDirection>("forward");
  const valueRef = useRef(initialValue);

  const select = useCallback((nextValue: T) => {
    const currentValue = valueRef.current;
    if (currentValue === nextValue) return;

    const currentIndex = order.indexOf(currentValue);
    const nextIndex = order.indexOf(nextValue);
    setDirection(nextIndex < currentIndex ? "back" : "forward");
    valueRef.current = nextValue;
    setValue(nextValue);
  }, [order]);

  return { value, direction, select };
}

interface IndicatorGeometry {
  offset: number;
  size: number;
  ready: boolean;
}

export function SlidingTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  idBase,
  variant = "page",
}: {
  items: readonly SlidingTabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  idBase: string;
  variant?: "page" | "segment" | "settings";
}) {
  const [settingsHorizontal, setSettingsHorizontal] = useState(false);
  useEffect(() => {
    if (variant !== "settings") return;
    const media = window.matchMedia("(max-width: 768px)");
    const update = () => setSettingsHorizontal(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [variant]);

  const vertical = variant === "settings" && !settingsHorizontal;
  const listRef = useRef<HTMLElement | null>(null);
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<IndicatorGeometry>({
    offset: 0,
    size: 0,
    ready: false,
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    const activeButton = buttonRefs.current.get(value);
    if (!list || !activeButton) return;

    const measure = () => {
      const offset = vertical ? activeButton.offsetTop : activeButton.offsetLeft;
      const size = vertical ? activeButton.offsetHeight : activeButton.offsetWidth;
      setIndicator((current) => current.ready && current.offset === offset && current.size === size
        ? current
        : { offset, size, ready: true });
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(list);
    observer.observe(activeButton);
    return () => observer.disconnect();
  }, [value, vertical]);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, itemIndex: number) => {
    const previousKey = vertical ? "ArrowUp" : "ArrowLeft";
    const nextKey = vertical ? "ArrowDown" : "ArrowRight";
    let nextIndex: number | null = null;

    if (event.key === previousKey) nextIndex = (itemIndex - 1 + items.length) % items.length;
    if (event.key === nextKey) nextIndex = (itemIndex + 1) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextItem = items[nextIndex];
    onChange(nextItem.id);
    window.requestAnimationFrame(() => buttonRefs.current.get(nextItem.id)?.focus());
  };

  const indicatorStyle: CSSProperties = vertical
    ? { height: indicator.size, transform: `translate3d(0, ${indicator.offset}px, 0)` }
    : { width: indicator.size, transform: `translate3d(${indicator.offset}px, 0, 0)` };
  const listClass = variant === "settings" ? styles.settingsNav : variant === "segment" ? styles.segmented : styles.pageTabs;
  const indicatorClass = variant === "settings" ? styles.settingsNavIndicator : variant === "segment" ? styles.segmentIndicator : styles.tabIndicator;
  const activeClass = variant === "settings" ? styles.settingsNavActive : variant === "segment" ? styles.segmentActive : styles.tabActive;
  const Element = vertical ? "aside" : "div";
  const list = (
    <Element
      ref={(node) => { listRef.current = node; }}
      className={listClass}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      data-orientation={vertical ? "vertical" : "horizontal"}
    >
      <span
        className={`${indicatorClass}${indicator.ready ? ` ${styles.indicatorReady}` : ""}`}
        style={indicatorStyle}
        aria-hidden="true"
      />
      {items.map((item, index) => {
        const Icon = item.icon;
        const active = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) buttonRefs.current.set(item.id, node);
              else buttonRefs.current.delete(item.id);
            }}
            id={`${idBase}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${idBase}-panel-${item.id}`}
            tabIndex={active ? 0 : -1}
            className={active ? activeClass : undefined}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {variant === "settings" ? (
              <>
                <span>{Icon && <Icon size={19} aria-hidden="true" />}</span>
                <span><strong>{item.label}</strong></span>
              </>
            ) : (
              <>
                {Icon && <Icon size={variant === "segment" ? 14 : 16} aria-hidden="true" />}
                {item.label}
                {item.markerLabel && <i aria-label={item.markerLabel} />}
              </>
            )}
          </button>
        );
      })}
    </Element>
  );

  return variant === "page" ? <div className={styles.tabScroller}>{list}</div> : list;
}

interface LeavingLayer {
  key: string;
  node: ReactNode;
  direction: PanelDirection;
  sequence: number;
}

export function DataFade({
  value,
  children,
}: {
  value: string | number | null | undefined;
  children: ReactNode;
}) {
  return (
    <span className={styles.dataFadeFrame}>
      <span key={String(value ?? "empty")} className={styles.dataFadeValue}>{children}</span>
    </span>
  );
}

export function DirectionalPanel({
  activeKey,
  direction,
  idBase,
  className,
  children,
}: {
  activeKey: string;
  direction: PanelDirection;
  idBase: string;
  className?: string;
  children: ReactNode;
}) {
  const previousKeyRef = useRef(activeKey);
  const previousNodeRef = useRef(children);
  const sequenceRef = useRef(0);
  const timeoutRef = useRef<number | null>(null);
  const [leaving, setLeaving] = useState<LeavingLayer | null>(null);

  useLayoutEffect(() => {
    if (previousKeyRef.current !== activeKey) {
      const sequence = ++sequenceRef.current;
      setLeaving({
        key: previousKeyRef.current,
        node: previousNodeRef.current,
        direction,
        sequence,
      });
      previousKeyRef.current = activeKey;
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        setLeaving((current) => current?.sequence === sequence ? null : current);
        timeoutRef.current = null;
      }, getScaledMotionDurationMs(210) + 48);
    }
    previousNodeRef.current = children;
  }, [activeKey, children, direction]);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  const enterClass = direction === "forward" ? styles.panelEnterForward : styles.panelEnterBack;
  const exitClass = leaving?.direction === "forward" ? styles.panelExitForward : styles.panelExitBack;

  return (
    <div className={`${styles.directionalPanel}${className ? ` ${className}` : ""}`}>
      {leaving && (
        <div
          key={`leaving-${leaving.key}-${leaving.sequence}`}
          className={`${styles.directionalLayer} ${styles.directionalLeaving} ${exitClass}`}
          aria-hidden="true"
          inert
        >
          {leaving.node}
        </div>
      )}
      <div
        key={`current-${activeKey}`}
        id={`${idBase}-panel-${activeKey}`}
        className={`${styles.directionalLayer} ${styles.directionalCurrent} ${enterClass}`}
        role="tabpanel"
        aria-labelledby={`${idBase}-tab-${activeKey}`}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
