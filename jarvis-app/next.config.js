/** @type {import('next').NextConfig} */
const withPWA = require('next-pwa')({
  dest: 'public',
  // `register: true` is a no-op under the App Router — it injects next-pwa's register
  // script into the `main.js` webpack entry, which App Router pages never load (they
  // load `main-app.js`). Harmless to leave set, but the service worker is actually
  // registered explicitly in src/app/page.tsx instead.
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  // next-pwa's App Router support precaches a few files it shouldn't: Next's internal
  // build manifest (never meant to be publicly fetchable — 404s, which fails the whole
  // service worker install step since every precache entry must fetch successfully) and
  // every API route's server-side JS chunk (not static assets at all). Root cause of
  // navigator.serviceWorker.ready hanging forever — the SW was permanently stuck mid-install.
  buildExcludes: [/app-build-manifest\.json$/, /static\/chunks\/app\/api\/.*\/route-[^/]+\.js$/],
});

module.exports = withPWA({
  reactStrictMode: true,
});
