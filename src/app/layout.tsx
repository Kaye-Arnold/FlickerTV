import type { Metadata, Viewport } from 'next';
import { ToastProvider } from '@/components/UI/Toast';
import OfflineBanner from '@/components/UI/OfflineBanner';
import InstallPrompt from '@/components/PWA/InstallPrompt';
import MemoryOverlay from '@/components/UI/MemoryOverlay';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flicker.TV — The MovieDom',
  description:
    'Decentralized public domain cinema and open-source indie films. ' +
    'Free, forever — streamed from the archive.',
  applicationName: 'Flicker.TV',
  keywords: [
    'public domain films',
    'free movies',
    'silent films',
    'classic cinema',
    'internet archive',
    'indie films',
    'open source film',
    'nosferatu',
    'buster keaton',
    'charlie chaplin',
  ],
  authors:   [{ name: 'Flicker.TV' }],
  creator:   'Flicker.TV',
  publisher: 'Flicker.TV',
  robots: {
    index:     true,
    follow:    true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type:        'website',
    locale:      'en_US',
    url:         'https://flicker.tv',
    siteName:    'Flicker.TV',
    title:       'Flicker.TV — The MovieDom',
    description: 'Discover 100 years of public domain cinema, free forever.',
    images: [
      {
        url:    '/og-image.jpg',
        width:  1200,
        height: 630,
        alt:    'Flicker.TV — The MovieDom',
      },
    ],
  },
  twitter: {
    card:        'summary_large_image',
    title:       'Flicker.TV — The MovieDom',
    description: 'Discover 100 years of public domain cinema, free forever.',
    images:      ['/og-image.jpg'],
    creator:     '@flickertv',
  },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icons/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192x192.png',  sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png',  sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  appleWebApp: {
    capable:         true,
    statusBarStyle:  'black-translucent',
    title:           'Flicker.TV',
  },
};

export const viewport: Viewport = {
  themeColor:     '#0a0a0f',
  width:          'device-width',
  initialScale:   1,
  maximumScale:   1,
  userScalable:   false,
  viewportFit:    'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://image.tmdb.org" />
        <link rel="preconnect" href="https://archive.org" />
        <link
          rel="preconnect"
          href="https://ia800100.us.archive.org"
          crossOrigin="anonymous"
        />
        <link rel="dns-prefetch" href="https://image.tmdb.org" />
        <link rel="dns-prefetch" href="https://archive.org" />
        <meta name="mobile-web-app-capable"             content="yes" />
        <meta name="apple-mobile-web-app-capable"       content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="format-detection"                   content="telephone=no" />
        <meta httpEquiv="Content-Security-Policy" content="worker-src 'self' blob:; script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:;" />
      </head>
      <body suppressHydrationWarning className="...">
            {/* Cinematic splash screen */}
            <div id="flicker-splash" className="flicker-splash" aria-hidden="true" suppressHydrationWarning>
          <div className="flicker-splash__wordmark">
            Flicker<span>.</span>TV
          </div>
          <div className="flicker-splash__tagline">The MovieDom</div>
          <div className="flicker-splash__reel" aria-hidden="true">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flicker-splash__frame" />
            ))}
          </div>
        </div>

        {/* App shell */}
        <ToastProvider>
          <OfflineBanner />
          {children}
          <InstallPrompt />
          <MemoryOverlay />
        </ToastProvider>

        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                if ('serviceWorker' in navigator) {
                  window.addEventListener('load', function() {
                    navigator.serviceWorker
                      .register('/sw.js', { scope: '/' })
                      .catch(function(err) {
                        console.warn('[Flicker.TV] SW registration failed:', err);
                      });
                  });
                }
                window.addEventListener('DOMContentLoaded', function() {
                  var splash = document.getElementById('flicker-splash');
                  if (splash) {
                    setTimeout(function() {
                      splash.classList.add('flicker-splash--hidden');
                      setTimeout(function() { splash.style.display = 'none'; }, 500);
                    }, 600);
                  }
                });
              })();
            `,
          }}
        />
      </body>
    </html>
  );
}