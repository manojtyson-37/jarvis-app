// Pure job-tracker rules: no network, no database. Everything that decides what is stored or pushed lives here,
// so it can be unit-tested. The model only proposes fields; these functions decide what is kept.

export const STATUSES = ['applied', 'moved_forward', 'interview', 'rejected', 'offer'] as const;
export type JobStatus = typeof STATUSES[number];

// Progress order. A later email can only move a process forward; "rejected" closes it unless an offer already exists.
const PROGRESS: Record<JobStatus, number> = { applied: 0, moved_forward: 1, interview: 2, rejected: 3, offer: 4 };

export const isStatus = (v: unknown): v is JobStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v);

// Lowercased, punctuation-free key for matching the same company or role across emails.
export function matchKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}

export function nextStatus(current: JobStatus | null, incoming: JobStatus): JobStatus {
  if (!current) return incoming;
  if (current === 'offer') return current;
  return PROGRESS[incoming] >= PROGRESS[current] ? incoming : current;
}

// Plain "application received" mail is not worth a push; progress and outcomes are.
export function shouldNotify(notified: JobStatus | null, status: JobStatus): boolean {
  return status !== 'applied' && status !== notified;
}

export interface JobExtract {
  company: string;
  role: string;
  status: JobStatus;
  evidence: string;
  ask: string;
}

// Validates the model's reply. Anything malformed returns null; the caller then marks the email seen, so it is not retried.
export function parseJobExtract(raw: unknown): JobExtract | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.is_job !== true || !isStatus(r.status)) return null;
  const company = typeof r.company === 'string' ? r.company.trim().slice(0, 120) : '';
  // A name with no letters or digits gives an empty match key, which the table rejects.
  if (!matchKey(company)) return null;
  const role = typeof r.role === 'string' ? r.role.trim().slice(0, 160) : '';
  const evidence = typeof r.evidence === 'string' ? r.evidence.trim().slice(0, 300) : '';
  const ask = typeof r.ask === 'string' ? r.ask.trim().slice(0, 300) : '';
  return { company, role, status: r.status, evidence, ask };
}

// A recruiter request waits 24 hours before one nudge, then stops. It never repeats and nothing is sent on his behalf.
export const ASK_NUDGE_AFTER_MS = 24 * 3600 * 1000;
export function askNudgeDue(askAt: string | null, nudgedAt: string | null, now: number): boolean {
  if (!askAt || nudgedAt) return false;
  return now - Date.parse(askAt) >= ASK_NUDGE_AFTER_MS;
}

// Gmail search for job mail. Automated senders (ATS notices) are kept on purpose: most application mail is automated.
export const JOB_QUERY = 'newer_than:3d -category:promotions -category:social (application OR applied OR interview OR offer OR "next steps" OR shortlisted OR assessment OR unfortunately OR "regret" OR recruiter OR "your profile" OR candidature)';
