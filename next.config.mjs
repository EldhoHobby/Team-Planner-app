/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal standalone server bundle for the Docker image.
  output: "standalone",
  reactStrictMode: true,
  // App runs behind the Caddy reverse proxy on the internal network.
  experimental: {
    serverActions: {
      // Largest body of ANY server action — the login action included, so
      // keep it small. Sized for task attachment uploads and the Excel imports
      // (Settings → Data checks MAX_IMPORT_UPLOAD_BYTES, a little below this). The big full-backup
      // restore upload does NOT go through a server action: it posts to the
      // route handler src/app/api/admin/restore, which enforces its own limit
      // (MAX_BACKUP_UPLOAD_BYTES in src/lib/services/full-backup-format.ts).
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
