import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

const PUBLIC_PATHS = ['/login', '/api/auth'];
const STATIC_EXTS = /\.(png|jpg|ico|svg|json|js|css|txt|xml)$/;

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (STATIC_EXTS.test(pathname)) return NextResponse.next();
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.JARVIS_API_SECRET ?? '';
  const valid = token ? await verifySessionToken(token, secret) : false;

  if (!valid) {
    const loginUrl = new URL('/login', req.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|sw\\.js|workbox-.*).*)'],
};
