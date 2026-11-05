---
name: git-push-user-only
description: "Never run `git push` for this user — prepare the commit, hand the push command back to them"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e7ebfd06-a5d0-4cb7-8fa5-07220b6c1342
---

Do NOT run `git push` (or any command that publishes to the remote) myself.
Staging, committing, and fixing commit contents is fine when asked, but the
push itself is the user's to run — give them the exact command instead.

**Why:** stated explicitly on 2026-07-05 after I completed a push while fixing
an oversized-file rejection; the user wants pushes under their own control.

**How to apply:** end git workflows with the ready-to-paste `git push` command
(plus any flags) rather than executing it. Same for anything remote-publishing
(e.g. gh pr create) unless they explicitly ask me to run it.
