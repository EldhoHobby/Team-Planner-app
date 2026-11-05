---
name: release-version-habit
description: Bump package.json version on every Team Planner release/deploy build (user-requested habit)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e7ebfd06-a5d0-4cb7-8fa5-07220b6c1342
---

When building a release/deploy bundle for the Team Planner app, ALWAYS bump
`package.json` "version" (e.g. 0.0.2 → 0.0.3). The footer shows
`v<version> (<git hash>) <build date>`; the date stamps in US Eastern
(TZ=America/New_York in the Dockerfile builder stage).

**Why:** the user tracks deployments by the footer version; it stayed at 0.0.1
across releases until they asked for this habit (2026-07-05).

**How to apply:** part of any "build the bundle" / "deploy" flow — bump version,
then build. See [[project-phase-status]] for the deployment setup.
