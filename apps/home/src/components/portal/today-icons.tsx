// Small line icons for Today's panels — stroke-only, 16px, inherit color.
const P = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
export const AlertIcon = () => <svg {...P}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>;
export const ActivityIcon = () => <svg {...P}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>;
export const FileIcon = () => <svg {...P}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>;
export const RepeatIcon = () => <svg {...P}><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>;
export const SparkIcon = () => <svg {...P}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" /></svg>;
export const InboxIcon = () => <svg {...P}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5h13l3.5 7v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7z" /></svg>;
export const CheckIcon = () => <svg {...P}><path d="M20 6 9 17l-5-5" /></svg>;
export const SearchIconSm = () => <svg {...P}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
export const FolderIcon = () => <svg {...P}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
export const ClockIcon = () => <svg {...P}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
