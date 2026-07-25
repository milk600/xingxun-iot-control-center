"use client";

import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { getScaledMotionDurationMs } from "@/app/lib/ui-preferences";
import { useAndroidBack } from "./useAndroidBack";
import styles from "./AnimatedSelect.module.css";

export interface AnimatedSelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

type MenuPhase = "closed" | "open" | "closing";
type MenuPlacement = "top" | "bottom";

export function AnimatedSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  compact = false,
}: {
  value: T;
  options: readonly AnimatedSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const reactId = useId();
  const listboxId = `animated-select-${reactId.replaceAll(":", "")}`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const closeTimerRef = useRef<number | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex] ?? options[0];
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [phase, setPhase] = useState<MenuPhase>("closed");
  const [placement, setPlacement] = useState<MenuPlacement>("bottom");
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const [darkSurface, setDarkSurface] = useState(false);
  const open = phase === "open";

  const finishClosing = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setPhase("closed");
    setMenuStyle(null);
  }, []);

  const closeMenu = useCallback((restoreFocus = true) => {
    if (phase === "closed") return;
    if (phase === "closing") {
      if (restoreFocus) triggerRef.current?.focus();
      return;
    }
    setPhase("closing");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 0 : getScaledMotionDurationMs(125) + 24;
    closeTimerRef.current = window.setTimeout(finishClosing, duration);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [finishClosing, phase]);

  useAndroidBack(open, () => closeMenu(true), 100);

  const openMenu = useCallback((nextIndex = selectedIndex) => {
    if (disabled || !options.length) return;
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setDarkSurface(Boolean(document.querySelector('[data-immersive="true"]')));
    setActiveIndex(nextIndex);
    setPhase("open");
  }, [disabled, options.length, selectedIndex]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!disabled) return;
    const frame = window.requestAnimationFrame(finishClosing);
    return () => window.cancelAnimationFrame(frame);
  }, [disabled, finishClosing]);

  useEffect(() => {
    if (phase !== "open") return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu(false);
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [closeMenu, phase]);

  useLayoutEffect(() => {
    if (phase === "closed") return;
    const positionMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportPadding = 12;
      const gap = 8;
      const estimatedHeight = Math.min(280, 12 + options.reduce(
        (total, option) => total + (option.description ? 58 : 46),
        0,
      ));
      const roomBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const roomAbove = rect.top - gap - viewportPadding;
      const nextPlacement: MenuPlacement = roomBelow < estimatedHeight && roomAbove > roomBelow
        ? "top"
        : "bottom";
      const availableHeight = Math.max(104, nextPlacement === "bottom" ? roomBelow : roomAbove);
      const renderedHeight = Math.min(estimatedHeight, availableHeight);
      const width = Math.min(rect.width, window.innerWidth - viewportPadding * 2);
      const left = Math.min(
        window.innerWidth - viewportPadding - width,
        Math.max(viewportPadding, rect.left),
      );
      const top = nextPlacement === "bottom"
        ? Math.min(window.innerHeight - viewportPadding - renderedHeight, rect.bottom + gap)
        : Math.max(viewportPadding, rect.top - gap - renderedHeight);
      setPlacement(nextPlacement);
      setMenuStyle({ top, left, width, maxHeight: availableHeight });
    };

    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [options, phase]);

  useLayoutEffect(() => {
    if (phase !== "open" || !menuStyle) return;
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, menuStyle, phase]);

  const moveActive = (nextIndex: number) => {
    const normalized = (nextIndex + options.length) % options.length;
    setActiveIndex(normalized);
  };

  const selectOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.value !== value) onChange(option.value);
    closeMenu(true);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      openMenu((selectedIndex + offset + options.length) % options.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      openMenu(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) closeMenu(true);
      else openMenu();
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(index + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveActive(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOption(index);
      return;
    }
    if (event.key === "Tab") closeMenu(false);
  };

  const menu = phase !== "closed" && createPortal(
    <div
      ref={menuRef}
      id={listboxId}
      className={`${styles.menu}${phase === "closing" ? ` ${styles.menuClosing}` : ""}`}
      style={menuStyle ?? undefined}
      role="listbox"
      aria-label={ariaLabel}
      data-state={phase}
      data-placement={placement}
      data-positioned={menuStyle ? "true" : "false"}
      data-tone={darkSurface ? "dark" : "light"}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const active = index === activeIndex;
        return (
          <button
            key={option.value}
            ref={(node) => { optionRefs.current[index] = node; }}
            id={`${listboxId}-option-${index}`}
            type="button"
            className={styles.option}
            role="option"
            aria-selected={selected}
            data-active={active || undefined}
            data-selected={selected || undefined}
            onPointerEnter={() => setActiveIndex(index)}
            onFocus={() => setActiveIndex(index)}
            onClick={() => selectOption(index)}
            onKeyDown={(event) => handleOptionKeyDown(event, index)}
          >
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            <i aria-hidden="true">{selected && <Check size={16} strokeWidth={2.2} />}</i>
          </button>
        );
      })}
    </div>,
    document.body,
  );

  return (
    <div ref={rootRef} className={`${styles.root}${compact ? ` ${styles.compact}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={phase !== "closed" ? listboxId : undefined}
        data-open={open || undefined}
        onClick={() => open ? closeMenu(true) : openMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={styles.value}>{selectedOption?.label ?? "请选择"}</span>
        <ChevronDown className={styles.chevron} size={16} strokeWidth={1.9} aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
}
