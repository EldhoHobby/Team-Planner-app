// App version + build date.
//
// APP_VERSION is bumped by hand. BUILD_DATE is injected at BUILD time from the
// NEXT_PUBLIC_BUILD_DATE env var (set in the Dockerfile builder stage to the
// current date as dd-mm-yyyy). Next.js inlines NEXT_PUBLIC_* at build, so the
// value is frozen to whenever the image was built. Locally (no env) it's blank
// and only the version shows.

export const APP_VERSION = "V0.0.1";

export const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE ?? "";

export const VERSION_LABEL = BUILD_DATE ? `${APP_VERSION} dated ${BUILD_DATE}` : APP_VERSION;
