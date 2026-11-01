import { NextRequest, NextResponse } from 'next/server';
import { decideAction } from '@/lib/actions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only the logged-in user can reach this (middleware checks the session cookie).
// The chat model has no tool that calls it, so it cannot approve its own actions.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, message: 'Invalid id.' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as { decision?: string; hash?: string };
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    return NextResponse.json({ ok: false, message: 'decision must be approve or reject.' }, { status: 400 });
  }

  if (body.decision === 'approve' && (typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash))) {
    return NextResponse.json({ ok: false, message: 'Approval must include the hash of the action that was shown.' }, { status: 400 });
  }

  try {
    const result = await decideAction('manoj', id, body.decision, body.hash);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (e) {
    console.error('decideAction failed:', (e as Error).message);
    return NextResponse.json({ ok: false, message: 'Something went wrong. Nothing was changed.' }, { status: 500 });
  }
}
