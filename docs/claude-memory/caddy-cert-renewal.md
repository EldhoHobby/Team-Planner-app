---
name: caddy-cert-renewal
description: "Dev Caddy internal TLS cert silently expired 2026-10-15 (renewal failed, key files missing); `docker compose restart proxy` re-issues it"
metadata:
  node_type: memory
  type: project
  originSessionId: 954d98c1-e888-4c85-b4fe-4570bdcb7c52
  modified: 2026-10-31T03:36:12.834Z
---

On the dev host the Caddy `tls internal` leaf cert for planner.localhost +
10.210.4.65 expired **2026-10-15** and was not renewed until 2026-10-30: Caddy
logged "certificate expires soon; queuing for renewal" every 10 min but failed —
`open /data/caddy/certificates/local/<host>/<host>.key: no such file or
directory` (key files gone from the caddy_data volume; a stale `issue_cert_*`
lock was also reported). `docker compose restart proxy` immediately obtained new
12-hour certs. Root cause of the missing files is unknown.

**Why:** browsers (incl. Claude's built-in browser) refuse the site with
ERR_CERT_DATE_INVALID; users had been clicking through warnings for 2 weeks.

**How to apply:** if the site shows a cert date error, check
`openssl s_client ... | openssl x509 -noout -dates` and the proxy log, then
restart proxy. Worth checking whether the SCADA host ([[project-phase-status]])
hit the same thing. If it recurs, investigate the caddy_data volume.
