/** @type {import('next').NextConfig} */
const isDevelopment = process.env.NODE_ENV !== 'production';
const scriptSources = [
  "'self'",
  "'unsafe-inline'",
  ...(isDevelopment ? ["'unsafe-eval'"] : []),
].join(' ');
const websocketSources = isDevelopment ? 'ws: wss:' : 'wss:';

const nextConfig = {
  // Next.js generates the static `out/` directory directly. The old
  // `next export` command is no longer supported in Next 14.
  output: 'export',
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'image.tmdb.org',
        port: '',
        pathname: '/t/p/**',
      },
      {
        protocol: 'https',
        hostname: 'archive.org',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.archive.org',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'upload.wikimedia.org',
        port: '',
        pathname: '/**',
      },
    ],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-XSS-Protection', value: '1; mode=block' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        {
          key: 'Permissions-Policy',
          value: 'camera=(), microphone=(), geolocation=()',
        },
        {
          key: 'Content-Security-Policy',
          value: [
            "default-src 'self'",
            // Static export emits Next's React Server Components bootstrap as
            // inline scripts. next.config.js cannot create a request-specific
            // nonce for immutable HTML, so this is the required static-export
            // fallback. Do not copy this policy to a nonce-capable server.
            `script-src ${scriptSources}`,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https://image.tmdb.org https://archive.org https://*.archive.org https://upload.wikimedia.org",
            "media-src 'self' blob: https://archive.org https://*.archive.org https://web.archive.org https://*.web.archive.org",
            `connect-src 'self' https://api.themoviedb.org https://archive.org https://*.archive.org https://web.archive.org https://*.web.archive.org https://gist.githubusercontent.com https://raw.githubusercontent.com ${websocketSources}`,            "worker-src 'self' blob:",
            "font-src 'self' data:",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
        },
      ],
    },
  ],
};

module.exports = nextConfig;