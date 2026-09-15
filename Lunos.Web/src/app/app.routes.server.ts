import { RenderMode, ServerRoute } from '@angular/ssr';

// Only the Phase 1 marketing routes are prerendered at build time (PRD §8: build-time
// prerendering, not a live SSR server). Anything not listed here — including the Phase 2
// marketplace/plugin routes when they're added — falls through to the '**' entry below and
// stays client-rendered, per the PRD.
export const serverRoutes: ServerRoute[] = [
  { path: '', renderMode: RenderMode.Prerender },
  { path: 'product', renderMode: RenderMode.Prerender },
  { path: 'roadmap', renderMode: RenderMode.Prerender },
  { path: 'docs', renderMode: RenderMode.Prerender },
  { path: 'sovereignty', renderMode: RenderMode.Prerender },
  { path: 'faq', renderMode: RenderMode.Prerender },
  { path: 'changelog', renderMode: RenderMode.Prerender },
  { path: 'contact', renderMode: RenderMode.Prerender },
  { path: 'about', renderMode: RenderMode.Prerender },
  { path: 'license', renderMode: RenderMode.Prerender },
  { path: '**', renderMode: RenderMode.Client },
];
