# Flicker.TV — Core Experience Specification

## Overview

This feature captures the core Flicker.TV experience: a vertically swipeable film feed with resilient playback across variable networks and decentralized sources. Key components involved are the `SwiperFeed` UI, `WaitingRoom` latency-masking UI, the `VideoCacheManager` for memory-safe blob handling, `useCatalog`/`feedStore` for catalog and feed state, service worker `sw.js` for PWA/offline behavior, and optional enrichment via `TMDB` and content fallback to `archive.org`.

## Goals

- Provide a smooth vertical swipe feed of films that feels native on touch and keyboard input (`SwiperFeed`).
- Ensure playback works under poor or flaky networks via adaptive strategies (Turbo Mode) and a `WaitingRoom` when needed.
- Resolve film sources from decentralized or remote locations while preferring local/peer caches managed by `VideoCacheManager`.
- Prevent uncontrolled memory growth by enforcing blob lifecycle and cleanup during/after playback.
- Support PWA offline shell and basic offline playback where assets are cached via `sw.js`.

## Non-Goals

- Implementing a full media CDN or building a new distributed storage protocol.
- Replacing existing catalog providers; this feature integrates with `useCatalog` and existing `feedStore` only.
- Full TMDB-based metadata pipeline — `TMDB` enrichment is optional and limited to display metadata only.

## Actors

- End user (mobile/desktop) interacting with `SwiperFeed`.
- Client app components: `SwiperFeed`, `WaitingRoom`, `VideoCacheManager`.
- Catalog providers: `useCatalog` (primary), optional `TMDB`, fallback `archive.org` sources.

## Functional Requirements (testable)

FR-1: Vertical Swipe Feed
- `SwiperFeed` must present a continuous vertical stack of film cards; swiping up/down moves focus to the next/previous film.
- Keyboard arrows and PageUp/PageDown must navigate equivalently.

FR-2: Adaptive Network Behavior / Turbo Mode
- Client must detect network quality (good/poor/offline) and expose a `Turbo Mode` state used by playback logic.
- Under poor networks, the app should reduce prebuffering and prefer lower-resolution or progressive stream variants within 2 seconds of detection.

FR-3: Source Resolution & Decentralized Fallback
- For each feed item, resolve usable playback URLs by querying `useCatalog` then local `VideoCacheManager` and finally remote sources such as `archive.org`.
- If a peer/local cache URL is available, prefer it over remote HTTP by default.

FR-4: WaitingRoom Latency Masking
- When no playable segment is immediately available (first-frame > 1500ms or buffering prevents >95% chance of 3s continuous playback), present `WaitingRoom` UI with progress and cancel controls.
- `WaitingRoom` must allow users to continue waiting, skip to next, or fallback to a lower-quality source.

FR-5: Memory-Safe Playback and Blob Cleanup
- `VideoCacheManager` must limit in-memory blobs to a configurable maximum (default: 2 concurrently held items).
- Blobs unused for more than 60s after playback end must be revoked and removed from memory; tests should detect no sustained growth in memory heap over 10 consecutive play/stop cycles.

FR-6: PWA / Offline Support
- `sw.js` must cache the app shell and a configurable small catalog subset; when offline, the feed UI loads the cached shell and any cached film assets; otherwise show an informative offline banner.

FR-7: feedStore & useCatalog Integration
- `feedStore` must expose items and playback state; `SwiperFeed` must consume `feedStore` and call `useCatalog` resolvers for missing source URLs.

FR-8: Optional TMDB Enrichment
- When configured, request TMDB metadata for a feed item asynchronously and display metadata without blocking playback resolution.

## Non-Functional Requirements

- NFR-1: Time-To-Interact (TTI) — primary feed view ready for user interaction within 2s on a 3G-equivalent simulated network.
- NFR-2: First-frame latency — when a playable source is available, first-frame should display within 1500ms on typical consumer Wi-Fi.
- NFR-3: Memory — sustained memory growth from repeated play/stop cycles must stay < 50MB over baseline for a 10-cycle test on desktop-class hardware.
- NFR-4: Offline resiliency — when offline, at least the app shell and navigation must function; attempting playback should present cached content or a clear fallback within 2s.
- NFR-5: Privacy & Security — do not leak any private keys or tokens in client-side logs; follow least-privilege for any API keys (TMDB optional).

## Edge Cases

- EC-1: Feed item with only a torrent/peer source and no HTTP mirror — attempt peer resolution first; if unavailable, surface readable error and allow skip.
- EC-2: Rapid swipe bursts — ensure `SwiperFeed` debounces navigation to avoid starting multiple simultaneous downloads; cancel prior prebuffer requests within 200ms of a new focus change.
- EC-3: Intermittent network drop during playback — degrade to audio-only or lower bitrate where possible; if no alternative, enter `WaitingRoom` and show retry.
- EC-4: Corrupt or truncated blob during playback — detect MediaError events and mark source as bad; attempt next-best source automatically.

## Acceptance Criteria / Success Criteria (measurable)

- AC-1: Navigation: 95% of manual vertical swipes result in the next/previous item becoming focused within 200ms.
- AC-2: Turbo Mode effectiveness: under simulated poor network, playback selects lower-resolution source and reduces rebuffer events by >= 40% compared to non-adaptive baseline.
- AC-3: WaitingRoom UX: When triggered, `WaitingRoom` appears within 300ms and provides controls to continue, skip, or choose fallback.
- AC-4: Memory: In an automated test of 10 play/stop cycles, heap memory increase attributable to blobs stays below 50MB.
- AC-5: Offline: With `sw.js` installed and app opened offline, main navigation and feed render within 2s and cached playable assets start playback within 3s if present.
- AC-6: Source resolution: For 99% of feed items in a 100-item test corpus, the app resolves at least one usable source (local cache, peer, `archive.org`, or HTTP) within 5s.

## Testing Notes (how to verify)

- Use network throttling (3G/slow 4G simulated) to validate TTI, first-frame, and Turbo Mode.
- Automate 10 play/stop cycles and measure memory via browser tooling to validate blob cleanup.
- Provide a test catalog with items that have: local cached URL, `archive.org` fallback, peer-only URL, and missing metadata to verify resolution logic.

## Assumptions

- The repository already includes integration points: `SwiperFeed`, `WaitingRoom`, `VideoCacheManager`, `useCatalog`, and `feedStore` as named in source.
- `sw.js` exists and can be augmented to cache small media assets; auditing service worker size/caching strategies is a separate task.
- `archive.org` provides fallback HTTP-hosted content for many archival films; where torrent/peer sources exist, peer discovery is possible but not guaranteed.
- TMDB usage is optional and must be behind a configuration toggle and rate-limited for privacy.

## Deliverables

- File: specs/main/spec.md (this document)
- Ready for `/speckit.plan` after your confirmation.

---

Summary: This spec defines a focused, testable core experience: vertical `SwiperFeed` navigation, adaptive Turbo Mode, decentralized source resolution (prefer cached/peer, fallback `archive.org`), `WaitingRoom` for latency masking, strict memory-safe blob lifecycle via `VideoCacheManager`, and PWA/offline support via `sw.js`. Acceptance criteria include measurable targets for navigation responsiveness, rebuffer reduction, memory bounds, and offline behavior.
