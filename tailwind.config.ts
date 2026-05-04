import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/lib/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        flicker: {
          gold:        '#c8a96e',
          'gold-light':'#e8c98a',
          black:       '#000000',
          dark:        '#0a0a0f',
          'dark-mid':  '#111118',
          surface:     '#17171f',
          raised:      '#1e1e28',
        },
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      backdropBlur: {
        cinema: '12px',
      },
      animation: {
        'shimmer':     'shimmer 1.6s infinite',
        'pulse-dot':   'pulseDot 1.2s ease-in-out infinite',
        'reel':        'reelFlicker 1s ease-in-out infinite',
        'spin-slow':   'spin 0.9s linear infinite',
      },
      keyframes: {
        shimmer: {
          '0%':   { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '0.3', transform: 'scale(0.85)' },
          '50%':      { opacity: '1',   transform: 'scale(1.1)'  },
        },
        reelFlicker: {
          '0%, 100%': { background: 'rgba(200,169,110,0.18)', transform: 'scaleY(0.7)' },
          '50%':      { background: '#c8a96e',                transform: 'scaleY(1)'   },
        },
      },
      screens: {
        xs: '375px',
      },
      height: {
        screen: '100dvh',
      },
      minHeight: {
        screen: '100dvh',
      },
    },
  },
  plugins: [],
};

export default config;