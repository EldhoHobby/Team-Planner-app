/**
 * One-off success message carried across a navigation inside Agreements (the
 * page that did the work is gone by the time it could show it — e.g. deleting a
 * draft proposal returns to the customer page). Session storage, read once.
 */
export const AGREEMENTS_FLASH_KEY = "agreements.flash";

export function leaveFlash(text: string) {
  try {
    sessionStorage.setItem(AGREEMENTS_FLASH_KEY, text);
  } catch {
    // storage blocked — the message is simply not shown
  }
}
