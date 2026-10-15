import type { StatusLevel } from "@/domain/status-config";

/* Inline SVG icons (no icon library). All are decorative: the words next to them carry the meaning. */

type IconProps = { className?: string };
const base = "h-7 w-7 shrink-0";
const svg = (className: string | undefined) => ({
  viewBox: "0 0 24 24",
  className: className ? `${className} shrink-0` : base,
  "aria-hidden": true as const,
  focusable: false as const,
});

/** Four different SHAPES, so the status reads without colour: octagon-!, down triangle, check circle, up triangle. */
export function StatusIcon({ level, className }: IconProps & { level: StatusLevel }) {
  switch (level) {
    case "CRITICAL":
      return (
        <svg {...svg(className)}>
          <polygon points="8,2 16,2 22,8 22,16 16,22 8,22 2,16 2,8" fill="currentColor" />
          <path d="M12 6.5v7" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          <circle cx="12" cy="17.5" r="1.8" fill="#fff" />
        </svg>
      );
    case "LOW":
      return (
        <svg {...svg(className)}>
          <polygon points="2.5,5 21.5,5 12,21" fill="currentColor" />
        </svg>
      );
    case "NORMAL":
      return (
        <svg {...svg(className)}>
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="3" />
          <path d="M7 12.5l3.5 3.5L17 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "HIGH":
      return (
        <svg {...svg(className)}>
          <polygon points="12,3 21.5,19 2.5,19" fill="currentColor" />
        </svg>
      );
  }
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const PlusIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M12 4v16M4 12h16" {...stroke} />
  </svg>
);
export const MinusIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M4 12h16" {...stroke} />
  </svg>
);
export const CloseIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M5 5l14 14M19 5L5 19" {...stroke} />
  </svg>
);
export const SlidersIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" {...stroke} />
    <circle cx="16" cy="7" r="2.5" {...stroke} />
    <circle cx="8" cy="17" r="2.5" {...stroke} />
  </svg>
);
export const ClockIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <circle cx="12" cy="12" r="9.5" {...stroke} />
    <path d="M12 6.5V12l3.5 2" {...stroke} />
  </svg>
);
export const InfinityIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M12 12c-2-3-3.5-4-5.5-4a4 4 0 100 8c2 0 3.5-1 5.5-4zm0 0c2 3 3.5 4 5.5 4a4 4 0 100-8c-2 0-3.5 1-5.5 4z" {...stroke} />
  </svg>
);
export const ExpiredIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <circle cx="12" cy="12" r="9.5" {...stroke} />
    <path d="M8 8l8 8M16 8l-8 8" {...stroke} />
  </svg>
);
export const HourglassIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9" {...stroke} />
  </svg>
);
export const AlertIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M12 3L2 20h20L12 3z" {...stroke} />
    <path d="M12 10v5" {...stroke} />
    <circle cx="12" cy="18" r="0.5" {...stroke} />
  </svg>
);
export const RefreshIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" {...stroke} />
  </svg>
);
export const CheckIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <path d="M4 12.5l5 5L20 6.5" {...stroke} />
  </svg>
);
export const UserIcon = ({ className }: IconProps) => (
  <svg {...svg(className)}>
    <circle cx="12" cy="8" r="4" {...stroke} />
    <path d="M4 21c0-4.5 3.5-7 8-7s8 2.5 8 7" {...stroke} />
  </svg>
);
