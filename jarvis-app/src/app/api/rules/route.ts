import { NextResponse } from 'next/server';
import { getRules, saveRule, updateRule, deactivateRule } from '@/lib/supabase';

// Manoj's standing rules for Maya: list, add, edit, remove. Behind the login middleware like every non-public route.
const USER_ID = 'manoj';
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export async function GET() {
  return NextResponse.json({ rules: await getRules(USER_ID) });
}

export async function POST(req: Request) {
  const t = text((await req.json().catch(() => ({}))).text);
  if (!t || t.length > 300) return bad('Rule must be 1 to 300 characters');
  try {
    await saveRule(USER_ID, t);
  } catch (e) {
    console.error('rules POST failed:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save the rule' }, { status: 500 });
  }
  return NextResponse.json({ rules: await getRules(USER_ID) });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const t = text(body.text);
  if (!ID_RE.test(String(body.id ?? ''))) return bad('Bad id');
  if (!t || t.length > 300) return bad('Rule must be 1 to 300 characters');
  try {
    await updateRule(USER_ID, String(body.id), t);
  } catch (e) {
    console.error('rules PATCH failed:', (e as Error).message);
    return NextResponse.json({ error: 'Could not update the rule' }, { status: 500 });
  }
  return NextResponse.json({ rules: await getRules(USER_ID) });
}

export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (!ID_RE.test(String(body.id ?? ''))) return bad('Bad id');
  try {
    await deactivateRule(USER_ID, String(body.id));
  } catch (e) {
    console.error('rules DELETE failed:', (e as Error).message);
    return NextResponse.json({ error: 'Could not remove the rule' }, { status: 500 });
  }
  return NextResponse.json({ rules: await getRules(USER_ID) });
}
