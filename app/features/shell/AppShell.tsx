"use client";

import {
  Activity,
  BellRing,
  CarFront,
  ChevronRight,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MoreHorizontal,
  RadioTower,
  ScanLine,
  ServerCog,
  Settings2,
  X,
  type LucideIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getScaledMotionDurationMs } from "@/app/lib/ui-preferences";
import { AiVoiceBar } from "@/app/features/ai/AiVoiceBar";
import { AiPageFocusManager } from "@/app/features/ai/AiPageFocusManager";
import { useAiControl } from "@/app/features/ai/AiControlContext";
import { useAuth } from "@/app/features/auth/AuthContext";
import { TransitionLink } from "@/app/features/transitions/NavigationTransition";
import { useAndroidBack } from "@/app/features/ui/useAndroidBack";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/app/lib/brand";
import styles from "./AppShell.module.css";

type AppSection =
  | "overview"
  | "digital-twin"
  | "vehicle"
  | "monitoring"
  | "alerts"
  | "integrations"
  | "settings";

type MoreMenuPhase = "closed" | "open" | "closing";

interface NavItem {
  id: AppSection;
  label: string;
  href: string;
  icon: LucideIcon;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { id: "overview", label: "控制概览", href: "/", icon: LayoutDashboard },
  { id: "digital-twin", label: "空间孪生", href: "/digital-twin", icon: ScanLine },
  { id: "vehicle", label: "小车遥控", href: "/vehicle", icon: CarFront },
  { id: "monitoring", label: "数据监测", href: "/monitoring", icon: Activity },
  { id: "alerts", label: "告警管理", href: "/alerts", icon: BellRing },
  { id: "integrations", label: "连接管理", href: "/integrations", icon: ServerCog },
  { id: "settings", label: "系统设置", href: "/settings", icon: Settings2 },
];

const MOBILE_ITEMS = NAV_ITEMS.slice(0, 4);

const ROUTE_META: Record<string, { section: AppSection; title: string }> = {
  "/": { section: "overview", title: "控制概览" },
  "/digital-twin": { section: "digital-twin", title: "空间孪生" },
  "/vehicle": { section: "vehicle", title: "小车遥控" },
  "/monitoring": { section: "monitoring", title: "数据监测" },
  "/alerts": { section: "alerts", title: "告警管理" },
  "/integrations": { section: "integrations", title: "连接管理" },
  "/settings": { section: "settings", title: "系统设置" },
};

const ROUTE_PREFETCH_IDLE_RETRY_MS = 120;
const ROUTE_PREFETCH_FALLBACK_DELAY_MS = 80;
const ROUTE_PREFETCH_AFTER_NAVIGATION_MS = 240;
const ROUTE_PREFETCH_MIN_IDLE_BUDGET_MS = 10;

function routeMeta(pathname: string) {
  return ROUTE_META[pathname] ?? ROUTE_META["/"];
}

function useRoutePrefetchScheduler(
  router: ReturnType<typeof useRouter>,
  pathname: string,
) {
  const pathnameRef = useRef(pathname);
  const prefetchedRoutesRef = useRef(new Set<string>());
  const requestIntentRef = useRef<(href: string) => void>(() => undefined);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    let disposed = false;
    let navigationActive = false;
    let delayTimer: number | null = null;
    let idleHandle: number | null = null;
    let pendingIntent: string | null = null;

    function clearScheduledPrefetch() {
      if (delayTimer !== null) {
        window.clearTimeout(delayTimer);
        delayTimer = null;
      }
      if (idleHandle !== null) {
        if (typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(idleHandle);
        }
        idleHandle = null;
      }
    }

    function schedulePrefetch(delayMs: number) {
      if (
        disposed ||
        navigationActive ||
        document.hidden ||
        delayTimer !== null ||
        idleHandle !== null ||
        pendingIntent === null
      ) {
        return;
      }

      delayTimer = window.setTimeout(() => {
        delayTimer = null;
        if (disposed || navigationActive || document.hidden) return;

        if (typeof window.requestIdleCallback === "function") {
          idleHandle = window.requestIdleCallback(runOnePrefetch);
          return;
        }

        delayTimer = window.setTimeout(
          () => runOnePrefetch(),
          ROUTE_PREFETCH_FALLBACK_DELAY_MS,
        );
      }, delayMs);
    }

    function runOnePrefetch(deadline?: IdleDeadline) {
      idleHandle = null;
      delayTimer = null;
      if (disposed || navigationActive || document.hidden) return;

      if (
        deadline &&
        deadline.timeRemaining() < ROUTE_PREFETCH_MIN_IDLE_BUDGET_MS
      ) {
        schedulePrefetch(ROUTE_PREFETCH_IDLE_RETRY_MS);
        return;
      }

      const href = pendingIntent;
      pendingIntent = null;
      if (!href) return;
      if (
        href === pathnameRef.current ||
        prefetchedRoutesRef.current.has(href)
      ) {
        return;
      }

      prefetchedRoutesRef.current.add(href);
      try {
        router.prefetch(href);
      } catch {
        prefetchedRoutesRef.current.delete(href);
      }

    }

    requestIntentRef.current = (href: string) => {
      if (
        href === pathnameRef.current ||
        prefetchedRoutesRef.current.has(href)
      ) {
        return;
      }

      pendingIntent = href;
      clearScheduledPrefetch();
      schedulePrefetch(0);
    };

    const navigationStart = () => {
      navigationActive = true;
      clearScheduledPrefetch();
    };
    const navigationEnd = () => {
      navigationActive = false;
      schedulePrefetch(ROUTE_PREFETCH_AFTER_NAVIGATION_MS);
    };
    const visibilityChange = () => {
      if (document.hidden) {
        clearScheduledPrefetch();
      } else {
        schedulePrefetch(ROUTE_PREFETCH_AFTER_NAVIGATION_MS);
      }
    };

    window.addEventListener("xingxun:navigation-start", navigationStart);
    window.addEventListener("xingxun:navigation-end", navigationEnd);
    document.addEventListener("visibilitychange", visibilityChange);

    return () => {
      disposed = true;
      clearScheduledPrefetch();
      requestIntentRef.current = () => undefined;
      window.removeEventListener("xingxun:navigation-start", navigationStart);
      window.removeEventListener("xingxun:navigation-end", navigationEnd);
      document.removeEventListener("visibilitychange", visibilityChange);
    };
  }, [router]);

  return useCallback((href: string) => {
    requestIntentRef.current(href);
  }, []);
}

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { connection: aiConnection, alerts, requestAlerts } = useAiControl();
  const pathname = usePathname();
  const router = useRouter();
  const requestRoutePrefetch = useRoutePrefetchScheduler(router, pathname);
  const current = routeMeta(pathname);
  const immersive = pathname === "/digital-twin";
  const activeNavIndex = Math.max(
    0,
    NAV_ITEMS.findIndex((item) => item.id === current.section),
  );
  const mobileActiveIndex = Math.min(activeNavIndex, 4);
  const moreCloseTimerRef = useRef<number | null>(null);
  const [moreMenu, setMoreMenu] = useState<{
    pathname: string;
    phase: MoreMenuPhase;
  }>({ pathname, phase: "closed" });
  const [accountOpen, setAccountOpen] = useState(false);
  const moreRendered =
    moreMenu.pathname === pathname && moreMenu.phase !== "closed";
  const moreOpen = moreMenu.pathname === pathname && moreMenu.phase === "open";
  const pendingAlertCount = alerts.list?.summary.pending ?? 0;

  useEffect(() => {
    if (aiConnection === "online" && alerts.listPhase === "idle") requestAlerts({ limit: 300 });
  }, [aiConnection, alerts.listPhase, requestAlerts]);

  const openMore = useCallback(() => {
    if (moreCloseTimerRef.current !== null) {
      window.clearTimeout(moreCloseTimerRef.current);
      moreCloseTimerRef.current = null;
    }
    setMoreMenu({ pathname, phase: "open" });
  }, [pathname]);

  const closeMore = useCallback(() => {
    if (!moreRendered) return;
    if (moreCloseTimerRef.current !== null) {
      window.clearTimeout(moreCloseTimerRef.current);
    }
    setMoreMenu({ pathname, phase: "closing" });
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    moreCloseTimerRef.current = window.setTimeout(() => {
      setMoreMenu((currentMenu) =>
        currentMenu.pathname === pathname
          ? { pathname, phase: "closed" }
          : currentMenu,
      );
      moreCloseTimerRef.current = null;
    }, reducedMotion ? 0 : getScaledMotionDurationMs(220));
  }, [moreRendered, pathname]);

  useAndroidBack(accountOpen || moreOpen, () => {
    if (accountOpen) setAccountOpen(false);
    else closeMore();
  }, 50);

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => {
      void import("@/app/features/digital-twin/preloadRoomOneTwinScene")
        .then(({ preloadRoomOneTwinScene }) => preloadRoomOneTwinScene())
        .catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(preloadTimer);
  }, []);

  useEffect(() => () => {
    if (moreCloseTimerRef.current !== null) {
      window.clearTimeout(moreCloseTimerRef.current);
    }
  }, []);

  return (
    <div className={`${styles.shell}${immersive ? ` ${styles.immersive}` : ""}`} data-immersive={immersive || undefined}>
      <aside className={styles.sidebar} aria-hidden={immersive || undefined}>
        <TransitionLink
          href="/"
          className={styles.brand}
          aria-label="返回控制概览"
          onPointerEnter={() => requestRoutePrefetch("/")}
          onFocus={() => requestRoutePrefetch("/")}
        >
          <span className={styles.brandMark} aria-hidden="true"><RadioTower size={22} /></span>
          <span><strong>{PRODUCT_NAME}</strong><small>{PRODUCT_TAGLINE}</small></span>
        </TransitionLink>

        <nav className={styles.nav} aria-label="主导航">
          <span
            className={styles.navActivePlate}
            style={{ transform: `translate3d(0, ${activeNavIndex * 54}px, 0)` }}
            aria-hidden="true"
          />
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = current.section === item.id;
            return (
              <TransitionLink
                key={item.id}
                href={item.href}
                className={active ? styles.activeNav : undefined}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                title={item.label}
                onPointerEnter={() => requestRoutePrefetch(item.href)}
                onFocus={() => requestRoutePrefetch(item.href)}
              >
                <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
                <span>{item.label}</span>
                {item.id === "alerts" && pendingAlertCount > 0 && <b className={styles.navBadge}>{Math.min(99, pendingAlertCount)}</b>}
              </TransitionLink>
            );
          })}
        </nav>

      </aside>

      <div className={styles.stage}>
        <header className={styles.topbar} aria-hidden={immersive || undefined}>
          <h1>{current.title}</h1>
          <div className={styles.accountArea}>
            <button
              type="button"
              className={styles.accountButton}
              aria-label="打开账户菜单"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((open) => !open)}
            >
              <AccountAvatar dataUrl={auth.profile?.avatarDataUrl ?? null} label={auth.profile?.displayName ?? auth.session?.user.displayName ?? "管理员"} compact />
            </button>
            {accountOpen && (
              <>
                <button type="button" className={styles.accountBackdrop} aria-label="关闭账户菜单" onClick={() => setAccountOpen(false)} />
                <aside className={styles.accountPopover} aria-label="账户菜单">
                  <div><AccountAvatar dataUrl={auth.profile?.avatarDataUrl ?? null} label={auth.profile?.displayName ?? auth.session?.user.displayName ?? "管理员"} /><p><strong>{auth.profile?.displayName ?? auth.session?.user.displayName ?? "管理员"}</strong><small>{auth.session?.user.username}</small></p></div>
                  <TransitionLink href="/settings" onClick={() => setAccountOpen(false)}><Settings2 size={17} />账户设置</TransitionLink>
                  <button type="button" onClick={() => void auth.lock()}><LockKeyhole size={17} />锁定</button>
                  <button type="button" onClick={() => void auth.signOut()}><LogOut size={17} />退出登录</button>
                </aside>
              </>
            )}
          </div>
        </header>
        <main className={styles.content}>{children}</main>
      </div>

      <nav className={styles.mobileNav} aria-label="移动端导航" aria-hidden={immersive || undefined}>
        <span
          className={styles.mobileActivePlate}
          style={{ transform: `translate3d(${mobileActiveIndex * 100}%, 0, 0)` }}
          aria-hidden="true"
        />
        {MOBILE_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = current.section === item.id;
          return (
            <TransitionLink
              key={item.id}
              href={item.href}
              className={active ? styles.mobileActive : undefined}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              onPointerEnter={() => requestRoutePrefetch(item.href)}
              onFocus={() => requestRoutePrefetch(item.href)}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{item.id === "overview" ? "概览" : item.id === "digital-twin" ? "空间" : item.id === "vehicle" ? "小车" : "数据"}</span>
            </TransitionLink>
          );
        })}
        <button
          type="button"
          className={!MOBILE_ITEMS.some((item) => item.id === current.section) ? styles.mobileActive : undefined}
          aria-label="更多页面"
          aria-expanded={moreOpen}
          onClick={moreOpen ? closeMore : openMore}
        >
          <MoreHorizontal size={20} aria-hidden="true" />
          <span>更多</span>
        </button>
      </nav>

      {moreRendered && !immersive && (
        <>
          <button
            type="button"
            className={`${styles.moreBackdrop}${moreMenu.phase === "closing" ? ` ${styles.moreBackdropClosing}` : ""}`}
            aria-label="关闭更多菜单"
            onClick={closeMore}
          />
          <aside className={`${styles.moreSheet}${moreMenu.phase === "closing" ? ` ${styles.moreSheetClosing}` : ""}`} aria-label="更多页面">
            <header><strong>更多</strong><button type="button" aria-label="关闭更多菜单" onClick={closeMore}><X size={19} /></button></header>
            <section className={styles.mobileAccount}>
              <div><AccountAvatar dataUrl={auth.profile?.avatarDataUrl ?? null} label={auth.profile?.displayName ?? auth.session?.user.displayName ?? "管理员"} /><p><strong>{auth.profile?.displayName ?? auth.session?.user.displayName ?? "管理员"}</strong><small>{auth.session?.user.username}</small></p></div>
              <span><button type="button" onClick={() => void auth.lock()}><LockKeyhole size={16} />锁定</button><button type="button" onClick={() => void auth.signOut()}><LogOut size={16} />退出</button></span>
            </section>
            {NAV_ITEMS.slice(4).map((item) => {
              const Icon = item.icon;
              return (
                <TransitionLink
                  key={item.id}
                  href={item.href}
                  aria-label={item.label}
                  onClick={closeMore}
                  onPointerEnter={() => requestRoutePrefetch(item.href)}
                  onFocus={() => requestRoutePrefetch(item.href)}
                >
                  <span><Icon size={20} /></span>
                  <strong>{item.label}</strong>
                  {item.id === "alerts" && pendingAlertCount > 0 && <b className={styles.moreBadge}>{Math.min(99, pendingAlertCount)}</b>}
                  <ChevronRight size={18} />
                </TransitionLink>
              );
            })}
          </aside>
        </>
      )}
      <AiPageFocusManager />
      <AiVoiceBar />
    </div>
  );
}

function AccountAvatar({ dataUrl, label, compact = false }: { dataUrl: string | null; label: string; compact?: boolean }) {
  return (
    <span
      className={`${styles.accountAvatar}${compact ? ` ${styles.accountAvatarCompact}` : ""}`}
      style={dataUrl ? { backgroundImage: `url(${JSON.stringify(dataUrl).slice(1, -1)})` } : undefined}
      aria-hidden="true"
    >
      {!dataUrl && label.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}
