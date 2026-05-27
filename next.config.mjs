/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ffmpeg.wasm and transformers.js need SharedArrayBuffer, which requires
  // these cross-origin isolation headers on every response.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" }
        ]
      }
    ];
  },
  webpack: (config, { isServer }) => {
    // Don't try to bundle node-only deps that transformers.js inspects
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        path: false,
        crypto: false,
        sharp: false,
        "onnxruntime-node": false
      };
    }
    return config;
  },
  // Allow external CDNs for ffmpeg core + transformers models
  experimental: {
    serverActions: { bodySizeLimit: "10mb" }
  }
};

export default nextConfig;
