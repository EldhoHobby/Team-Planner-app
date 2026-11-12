// Where the job actions menu's "Reassign to" submenu opens (pure, testable).

/** Width of the actions menu (w-52) and of the fly-out submenu (w-48), in px. */
export const MENU_W = 208;
export const SUBMENU_W = 192;
const GAP = 4;
const EDGE = 4;

/**
 * "right" when the fly-out fits right of the menu, else "left" when it fits on
 * the left, else "inline" (a narrow phone screen: it opens under its item,
 * inside the menu).
 */
export function subPlacementFor(menuLeft: number, viewportWidth: number): "right" | "left" | "inline" {
  if (menuLeft + MENU_W + GAP + SUBMENU_W <= viewportWidth - EDGE) return "right";
  if (menuLeft - GAP - SUBMENU_W >= EDGE) return "left";
  return "inline";
}
