import { useSyncExternalStore } from "react";

const ROUTE_CHANGE_EVENT = "xingxun:offline-route-change";
const listeners = new Set<() => void>();

function notifyRouteChange() {
  window.XingXunCloud?.setActiveRoute?.(currentPathname());
  for (const listener of listeners) listener();
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
}

function currentPathname() {
  return window.location.pathname || "/";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", notifyRouteChange);
}

const router = {
  push(href: string) {
    const target = new URL(href, window.location.href);
    window.history.pushState({}, "", `${target.pathname}${target.search}${target.hash}`);
    notifyRouteChange();
  },
  replace(href: string) {
    const target = new URL(href, window.location.href);
    window.history.replaceState({}, "", `${target.pathname}${target.search}${target.hash}`);
    notifyRouteChange();
  },
  back() {
    window.history.back();
  },
  forward() {
    window.history.forward();
  },
  refresh() {
    notifyRouteChange();
  },
  prefetch() {
    return Promise.resolve();
  },
};

export function usePathname() {
  return useSyncExternalStore(subscribe, currentPathname, () => "/");
}

export function useRouter() {
  return router;
}

export function useSearchParams() {
  const pathname = usePathname();
  void pathname;
  return new URLSearchParams(window.location.search);
}

export function useParams() {
  return {};
}

export function redirect(href: string): never {
  router.replace(href);
  throw new Error(`Redirected to ${href}`);
}

export function notFound(): never {
  throw new Error("Route not found");
}
