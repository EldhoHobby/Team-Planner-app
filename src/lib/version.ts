// App version + build date.
//
// APP_VERSION is bumped by hand. BUILD_DATE is injected at BUILD time from the
// NEXT_PUBLIC_BUILD_DATE env var (set in the Dockerfile builder stage to the
// current date as MM/DD/YYYY). Next.js inlines NEXT_PUBLIC_* at build, so the
// value is frozen to whenever the image was built. Locally (no env) it's blank
// and only the version shows.

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "V0.0.1";

export const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE ?? "";

export const GIT_HASH = process.env.NEXT_PUBLIC_GIT_HASH ?? "";

export const VERSION_LABEL = [
  APP_VERSION,
  GIT_HASH ? `(${GIT_HASH})` : null,
  BUILD_DATE ? `dated ${BUILD_DATE}` : null,
]
  .filter(Boolean)
  .join(" ");
