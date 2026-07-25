export const DIGITAL_TWIN_NAVIGATION_START = "xingxun:navigation-start";

interface NavigationStartDetail {
  from?: string;
  to?: string;
}

function pathnameFromNavigationValue(value: string) {
  return new URL(value, window.location.href).pathname;
}

export function isDigitalTwinExitNavigation(event: Event) {
  const detail = (event as CustomEvent<NavigationStartDetail>).detail;
  if (!detail?.from || !detail.to) return false;

  try {
    return pathnameFromNavigationValue(detail.from) === "/digital-twin"
      && pathnameFromNavigationValue(detail.to) !== "/digital-twin";
  } catch {
    return false;
  }
}
