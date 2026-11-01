import { NextResponse } from 'next/server';
import { listPendingActions } from '@/lib/actions';

// Session-gated by middleware (not in PUBLIC_PATHS).
export async function GET() {
  try {
    const actions = await listPendingActions('manoj');
    return NextResponse.json({ actions });
  } catch (e) {
    console.error('list pending actions failed:', (e as Error).message);
    return NextResponse.json({ actions: [] }, { status: 500 });
  }
}
