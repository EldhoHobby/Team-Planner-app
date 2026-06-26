/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal standalone server bundle for the Docker image.
  output: "standalone",
  reactStrictMode: true,
  // App runs behind the Caddy reverse proxy on the internal network.
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb", // accommodate task attachment uploads
    },
  },
};

export default nextConfig;
