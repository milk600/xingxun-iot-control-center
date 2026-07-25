/**
 * Canonical orthographic basis for the bundled synthetic demo room.
 * `direction` points upward, `up` is the visual top edge, and `right`
 * completes a right-handed screen plane.
 */
export const ROOM_ONE_TOP_DIRECTION = [0, 1, 0] as const;
export const ROOM_ONE_TOP_UP = [0, 0, -1] as const;
export const ROOM_ONE_TOP_RIGHT = [1, 0, 0] as const;

export const ROOM_ONE_TOP_MAP_ASSETS = {
  image: "/models/room-01/room-top-map.svg?v=1",
  mask: "/models/room-01/room-top-mask.svg?v=1",
  manifest: "/models/room-01/room-top-map.json?v=1",
} as const;

export const ROOM_ONE_NAVIGATION_MAP_ASSETS = {
  image: "/models/room-01/room-navigation-overhead-map.svg?v=1",
  mask: "/models/room-01/room-top-mask.svg?v=1",
  manifest: ROOM_ONE_TOP_MAP_ASSETS.manifest,
} as const;

/**
 * Full-frame coordinate basis used by the vehicle remote and every spatial
 * distribution card. Normalized map coordinates map directly to this image.
 */
export const ROOM_ONE_NAVIGATION_MAP_VIEW = {
  width: 1_600,
  height: 1_000,
  contentBounds: {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
  },
} as const;
