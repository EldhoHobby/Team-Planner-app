"use client";

/**
 * Print a page without leaving the current one (no new tab): load it in an off-screen iframe and
 * open the browser's print dialog for it ("Save as PDF" included). `title` becomes the default PDF
 * file name. `onReady` fires once the dialog has been opened (or loading failed).
 */
export function printInFrame(url: string, title: string, onReady?: () => void) {
  document.getElementById("sa-print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.id = "sa-print-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Off-screen but laid out at a normal size (a 0×0 or hidden frame can print blank in some browsers).
  Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: "1200px", height: "900px", border: "0" });
  const prevTitle = document.title;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onReady?.();
  };
  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) return finish();
    try {
      w.document.title = title;
      document.title = title; // Chrome / Edge name the PDF after a title — set both
      w.addEventListener("afterprint", () => { document.title = prevTitle; });
      // Give fonts / layout a moment, then print.
      setTimeout(() => {
        try {
          w.focus();
          w.print();
        } finally {
          finish();
          // Some browsers return from print() before the dialog closes; restore the title later as a fallback.
          setTimeout(() => { document.title = prevTitle; }, 60_000);
        }
      }, 300);
    } catch {
      document.title = prevTitle;
      finish();
      window.location.href = url; // fall back to opening the print page here
    }
  };
  frame.src = url;
  document.body.appendChild(frame);
}
