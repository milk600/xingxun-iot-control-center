const MIN_DISMISS_DISTANCE_PX = 64;
const MAX_DISMISS_DISTANCE_PX = 112;
const FAST_SWIPE_MIN_DISTANCE_PX = 28;
const FAST_SWIPE_VELOCITY_PX_PER_MS = 0.55;

export function shouldDismissAndroidAgentPanel(
  distancePx: number,
  durationMs: number,
  panelHeightPx: number,
) {
  const distance = Math.max(0, distancePx);
  const duration = Math.max(1, durationMs);
  const height = Math.max(0, panelHeightPx);
  const distanceThreshold = Math.min(
    MAX_DISMISS_DISTANCE_PX,
    Math.max(MIN_DISMISS_DISTANCE_PX, height * 0.18),
  );
  const velocity = distance / duration;

  return distance >= distanceThreshold
    || (distance >= FAST_SWIPE_MIN_DISTANCE_PX
      && velocity >= FAST_SWIPE_VELOCITY_PX_PER_MS);
}

export function androidAgentPanelDismissOffset(panelHeightPx: number) {
  return Math.max(220, Math.max(0, panelHeightPx) + 28);
}
