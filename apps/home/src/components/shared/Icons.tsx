// Inline SVG icon set (Lucide-derived) — zero runtime deps. 24px viewBox, stroke icons
// inherit `currentColor`. Used across the portal nav + sections. (If the team later adds
// lucide-react, these can be swapped 1:1.)
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export type IconComponent = (p: IconProps) => JSX.Element;

export const UserIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>
);
export const BuildingIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M6 22V4l6-2 6 2v18M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01M3 22h18" /></Svg>
);
export const LandmarkIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M3 22h18M4 10h16M5 6l7-3 7 3M6 10v8M10 10v8M14 10v8M18 10v8" /></Svg>
);
export const DatabaseIcon: IconComponent = (p) => (
  <Svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0" /></Svg>
);
export const LinkIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" /></Svg>
);
export const ShieldIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></Svg>
);
export const HistoryIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" /></Svg>
);
export const CheckCircleIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M21.8 10A10 10 0 1 1 17 3.3M22 5 12 15l-3-3" /></Svg>
);
export const UnlinkIcon: IconComponent = (p) => (
  <Svg {...p}><path d="m18.8 4-3 3M9.2 14l-3 3M2 22l3-3M22 2l-3 3M9 17H7A5 5 0 0 1 7 7M15 7h2a5 5 0 0 1 2 9" /></Svg>
);
export const LockIcon: IconComponent = (p) => (
  <Svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>
);
export const CopyIcon: IconComponent = (p) => (
  <Svg {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>
);
export const ExternalLinkIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Svg>
);
export const ChevronDownIcon: IconComponent = (p) => (<Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>);
export const MenuIcon: IconComponent = (p) => (<Svg {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Svg>);
export const XIcon: IconComponent = (p) => (<Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>);
export const CheckIcon: IconComponent = (p) => (<Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>);
export const FingerprintIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M12 10a2 2 0 0 0-2 2c0 1.5.5 3 1 4M5 7a10 10 0 0 1 14 0M8 11a4 4 0 0 1 8 0c0 2 0 4 1 6M12 11a8 8 0 0 1 0 8M3 11a9 9 0 0 1 2-5" /></Svg>
);
export const MonitorIcon: IconComponent = (p) => (
  <Svg {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>
);
export const HomeIcon: IconComponent = (p) => (
  <Svg {...p}><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" /></Svg>
);
