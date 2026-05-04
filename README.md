# Flicker.TV — The MovieDom

> Decentralized Progressive Web App for Public Domain Cinema and Open-Source Indie Films.

---

## Stack

## Architecture Overview

### Key Features
- **Global State Management**: Utilizes `feedStore` for managing application state across components.
- **Custom Data Fetching**: Implements `useCatalog` hook for efficient data retrieval and management.
- **Dynamic Component Loading**: Uses `SwiperFeed` for rendering HLS videos dynamically, enhancing performance and user experience.

### Architecture Components
- **Pages**: Organized under `src/app` for routing and layout management.
- **Components**: Modular components located in `src/components` for reusability.
- **Hooks**: Custom hooks in `src/hooks` for encapsulating logic and state management.
- **Library**: Shared utilities and API interactions in `src/lib`.

### Development Commands
- To initialize the project, use:
  ```bash
  npx create-next-app@latest . --ts --tailwind
  ```


| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router, Static Export) |
| Language | TypeScript 5 (strict) |
| Styling | Tailwind CSS + scoped inline CSS |
| Animation | Framer Motion |
| Feed | Swiper.js (Virtual slides) |
| State | Zustand (persisted) |
| Film Data | Internet Archive API (no key required) |
| Enrichment | TMDB API (optional) |
| PWA | Custom Service Worker (3-tier cache) |
| Memory | Zero-copy VideoCacheManager (WeakMap + OOM guard) |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (TMDB token is optional)
cp .env.local.example .env.local

# 3. Start development server
npm run dev

# 4. Build static export (deployable to any CDN)
npm run build
```

---

## Architecture

### Feed (`SwiperFeed.tsx`)
TikTok-style vertical swipe feed built on Swiper.js Virtual slides.
Turbo Mode activates automatically on 2G/3G connections — swaps video
autoplay for static WebP posters to save mobile data.

### Waiting Room (`WaitingRoom.tsx`)
4-phase latency-masking UI that masks the delay of connecting to
decentralized film nodes:
- **Phase 1 (0–1s):** Shimmer skeleton UI
- **Phase 2 (1–3s):** High-res poster + "Resolving Encrypted Mesh…" overlay
- **Phase 3 (3s+):** Rotating public domain cinema trivia
- **Phase 4:** Fade out → video player appears

### Memory Manager (`VideoCacheManager.ts`)
Zero-copy video blob manager with:
- `WeakMap<HTMLVideoElement, ChunkRegistry>` — ties chunk lifetime to DOM node lifetime
- `URL.revokeObjectURL()` called **immediately** upon consumption (prevents Android OOM)
- 512 MB hard ceiling with LRU eviction sweeper
- Periodic stale-registry cleanup for detached video elements

### Service Worker (`sw.js`)
3-tier caching strategy:
- **Shell cache:** App shell assets (cache-first, long-lived)
- **Poster cache:** Film images (stale-while-revalidate, 200-item LRU)
- **Runtime cache:** API responses (network-first, 10s timeout, 50-item LRU)
- Video streams intentionally **not cached** (handled by VideoCacheManager)

---

## Deployment

Static export — deploy the `out/` directory to any CDN:

```bash
npm run build
# Outputs to ./out/

# Netlify
netlify deploy --dir=out --prod

# Vercel
vercel --prod

# Cloudflare Pages
wrangler pages deploy out
```

---

## Public Domain Film Sources

All seed films sourced from the [Internet Archive](https://archive.org/details/movies).
Films in the seed reel are confirmed US public domain as of 2024 (pre-1929 copyright registration).

---

## License

MIT — build freely, screen freely.