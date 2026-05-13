/** @type {import('next').NextConfig} */
const nextConfig = {  trailingSlash: true,
  skipTrailingSlashRedirect: true,  images: {
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
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https://image.tmdb.org https://archive.org https://*.archive.org https://upload.wikimedia.org",
            "media-src 'self' blob: https://archive.org https://*.archive.org",
            "connect-src 'self' https://api.themoviedb.org https://archive.org https://*.archive.org https://gist.githubusercontent.com https://raw.githubusercontent.com",
            "worker-src 'self' blob:",
            "font-src 'self' data:",
          ].join('; '),
        },
      ],
    },
  ],
};

module.exports = nextConfig;