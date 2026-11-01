// Lucide-style stroke icons, inline so there is no extra dependency. Decorative by default (aria-hidden).
type P = { className?: string };
const base = (children: React.ReactNode, className = 'w-5 h-5') => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export const ChatIcon = ({ className }: P) => base(<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />, className);
export const NoteIcon = ({ className }: P) => base(<><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" /><path d="M15 3v6h6" /><path d="M9 13h6M9 17h6" /></>, className);
export const BellIcon = ({ className }: P) => base(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>, className);
export const ActivityIcon = ({ className }: P) => base(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />, className);
export const MicIcon = ({ className }: P) => base(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" /></>, className);
export const SendIcon = ({ className }: P) => base(<><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>, className);
export const XIcon = ({ className }: P) => base(<path d="M18 6 6 18M6 6l12 12" />, className);
export const CheckIcon = ({ className }: P) => base(<path d="M20 6 9 17l-5-5" />, className);
export const LogOutIcon = ({ className }: P) => base(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>, className);
export const WaveIcon = ({ className }: P) => base(<path d="M2 10v3M6 6v11M10 3v18M14 8v8M18 5v14M22 10v3" />, className);
export const MailIcon = ({ className }: P) => base(<><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></>, className);
export const FileIcon = ({ className }: P) => base(<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>, className);
export const CalendarIcon = ({ className }: P) => base(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>, className);
export const ChevronIcon = ({ className }: P) => base(<path d="m6 9 6 6 6-6" />, className);
export const SparkIcon = ({ className }: P) => base(<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />, className);
export const TrashIcon = ({ className }: P) => base(<><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>, className);
export const RefreshIcon = ({ className }: P) => base(<><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>, className);
export const ShieldIcon = ({ className }: P) => base(<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />, className);
