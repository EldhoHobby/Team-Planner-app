---
name: user-profile
description: "User role, environment, and working preferences for this project"
metadata: 
  node_type: memory
  type: user
  originSessionId: c919bffe-3b1b-4d56-bb79-b3877389c291
---

Building a self-hosted team planning app (Docker Compose, Next.js 15, Postgres, Prisma).

- Windows 11, PowerShell 5.1 as primary shell — chain commands with `;` not `&&`
- Node.js is NOT in the shell PATH; builds happen inside Docker via `docker compose up --build`
- TypeScript type checking runs in Docker too — can't run `tsc` locally
- Prefers minimal new npm dependencies; reuses native HTML + Tailwind over installing new shadcn components when possible
- shadcn/ui new-york style, Tailwind v3
