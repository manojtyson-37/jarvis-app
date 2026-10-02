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
});

module.exports = withPWA({
  reactStrictMode: true,
});
