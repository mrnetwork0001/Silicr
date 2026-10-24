// Silicr icon set: etched-on-silicon line icons (replaces the stock icon package).
// 24x24 grid, round caps and joins, 1.6 stroke in currentColor, with a small
// accent element painted in var(--icon-accent, #ee7f20). Self-contained: the
// same file lives in apps/landing and apps/web.
import type { CSSProperties, ReactElement, ReactNode, Ref, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string;
  strokeWidth?: number | string;
  ref?: Ref<SVGSVGElement>;
}
export type IconComponent = ((props: IconProps) => ReactElement) & { displayName?: string };
export type LucideIcon = IconComponent;

const BASE: CSSProperties = { display: 'inline-block', flexShrink: 0 };
const ACC: CSSProperties = { fill: 'var(--icon-accent, #ee7f20)', stroke: 'none' };
const ACC_STROKE: CSSProperties = { stroke: 'var(--icon-accent, #ee7f20)' };
const INK: CSSProperties = { fill: 'currentColor', stroke: 'none' };

function make(name: string, body: ReactNode): IconComponent {
  function Icon({ size = 24, strokeWidth = 1.6, className, style, ref, ...rest }: IconProps) {
    const labelled = rest['aria-label'] != null;
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style ? { ...BASE, ...style } : BASE}
        aria-hidden={labelled ? undefined : true}
        role={labelled ? 'img' : undefined}
        focusable="false"
        {...rest}
      >
        {body}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

const dot = (cx: number, cy: number, r = 1.3) => <circle cx={cx} cy={cy} r={r} style={ACC} />;
const SHIELD = 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z';
const EYE = 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z';
const FILE = 'M6.5 3h7.5l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z';
const FOLD = 'M14 3v5h5';
const HEART = 'M12 20s-8-4.6-8-10.6A4.4 4.4 0 0 1 12 6.8a4.4 4.4 0 0 1 8 2.6C20 15.4 12 20 12 20z';
const CIRCLE = <circle cx="12" cy="12" r="9" />;

/* ---- utility: arrows, chevrons, marks ---- */
export const ArrowDown = make('ArrowDown', <path d="M12 4v15M6 13l6 6 6-6" />);
export const ArrowUp = make('ArrowUp', <path d="M12 20V5M6 11l6-6 6 6" />);
export const ArrowLeft = make('ArrowLeft', <path d="M20 12H5M11 6l-6 6 6 6" />);
export const ArrowUpDown = make('ArrowUpDown', <path d="M8 19.5V4.5M4.5 8L8 4.5 11.5 8M16 4.5v15M12.5 16l3.5 3.5 3.5-3.5" />);
export const ArrowUpRight = make('ArrowUpRight', <path d="M7 17L17 7M8.5 7H17v8.5" />);
export const ChevronDown = make('ChevronDown', <><path d="M6 9.5l6 6 6-6" />{dot(12, 15.5, 1.05)}</>);
export const ChevronRight = make('ChevronRight', <><path d="M9.5 6l6 6-6 6" />{dot(15.5, 12, 1.05)}</>);
export const Check = make('Check', <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const X = make('X', <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);
export const Minus = make('Minus', <path d="M5 12h14" />);
export const Menu = make('Menu', <><path d="M4 6.5h16M4 12h16M4 17.5h11" />{dot(18.6, 17.5, 1.2)}</>);
export const Square = make('Square', <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />);
export const Copy = make(
  'Copy',
  <><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5" /></>,
);
export const Loader2 = make('Loader2', <><path d="M12 3a9 9 0 1 0 9 9" />{dot(21, 12, 1.5)}</>);
export const ExternalLink = make(
  'ExternalLink',
  <path d="M19 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5h5M14.5 4H20v5.5M20 4l-8.5 8.5" />,
);
export const Download = make('Download', <path d="M12 4v11M7 10.5l5 5 5-5M4.5 20h15" />);
export const Send = make('Send', <><path d="M20.5 3.5L10.5 13.5M20.5 3.5l-6 17-4-7-7-4z" />{dot(10.5, 13.5, 1.2)}</>);
export const RefreshCw = make('RefreshCw', <path d="M19.5 10.5A7.8 7.8 0 0 0 5.5 7L4 8.5M4 4v4.5h4.5M4.5 13.5A7.8 7.8 0 0 0 18.5 17l1.5-1.5M20 20v-4.5h-4.5" />);
export const RotateCcw = make('RotateCcw', <><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.7M4 4v4.7h4.7" />{dot(12, 12, 1.3)}</>);

/* ---- media ---- */
export const Play = make('Play', <path d="M7 4.5l12 7.5-12 7.5z" />);
export const Pause = make('Pause', <><rect x="6" y="5" width="4" height="14" rx="1.2" /><rect x="14" y="5" width="4" height="14" rx="1.2" /></>);
export const PlayCircle = make('PlayCircle', <>{CIRCLE}<path d="M10 8.5l5.5 3.5-5.5 3.5z" style={ACC} /></>);
export const PauseCircle = make('PauseCircle', <>{CIRCLE}<path d="M10 9v6" /><path d="M14 9v6" style={ACC_STROKE} /></>);

/* ---- status ---- */
export const Info = make('Info', <>{CIRCLE}<path d="M12 11v5.5" />{dot(12, 7.8, 1.25)}</>);
export const CircleAlert = make('CircleAlert', <>{CIRCLE}<path d="M12 7.5V13" />{dot(12, 16.4, 1.25)}</>);
export const CircleSlash = make('CircleSlash', <>{CIRCLE}<path d="M8.5 15.5l7-7" />{dot(12, 12, 1.1)}</>);
export const TriangleAlert = make(
  'TriangleAlert',
  <><path d="M10.6 4.3a1.6 1.6 0 0 1 2.8 0l7.6 13.3a1.6 1.6 0 0 1-1.4 2.4H4.4A1.6 1.6 0 0 1 3 17.6z" /><path d="M12 9.5v4" />{dot(12, 16.7, 1.2)}</>,
);
export const BadgeCheck = make(
  'BadgeCheck',
  <><path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6z" /><path d="M8.5 12.3l2.4 2.4 4.6-4.8" /></>,
);

/* ---- security ---- */
export const Lock = make(
  'Lock',
  <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />{dot(12, 14.6, 1.5)}<rect x="11.35" y="14.6" width="1.3" height="3" rx="0.6" style={ACC} /></>,
);
export const KeyRound = make(
  'KeyRound',
  <><circle cx="8" cy="16" r="4.5" /><path d="M11.2 12.8L20 4M16.5 7.5L19 10M14.5 9.5l1.8 1.8" />{dot(8, 16, 1.4)}</>,
);
export const Shield = make('Shield', <><path d={SHIELD} />{dot(12, 11.5, 1.9)}</>);
export const ShieldCheck = make('ShieldCheck', <><path d={SHIELD} /><path d="M9 11.8l2.1 2.1 4-4.2" /></>);
export const ShieldAlert = make('ShieldAlert', <><path d={SHIELD} /><path d="M12 7.8v4" />{dot(12, 15, 1.2)}</>);
export const ShieldX = make('ShieldX', <><path d={SHIELD} /><path d="M9.6 9.3l4.8 4.8M14.4 9.3l-4.8 4.8" /></>);
export const Eye = make('Eye', <><path d={EYE} /><circle cx="12" cy="12" r="3" />{dot(12, 12, 1.25)}</>);
export const EyeOff = make('EyeOff', <><path d={EYE} /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></>);
export const ScanEye = make(
  'ScanEye',
  <><path d="M4 8.5v-3L5.5 4h3M15.5 4h3L20 5.5v3M20 15.5v3L18.5 20h-3M8.5 20h-3L4 18.5v-3" /><path d="M7 12s2-3.5 5-3.5 5 3.5 5 3.5-2 3.5-5 3.5S7 12 7 12z" />{dot(12, 12, 1.4)}</>,
);
export const FileLock = make(
  'FileLock',
  <><path d={FILE} /><path d={FOLD} /><rect x="8.75" y="13.5" width="6.5" height="4.75" rx="1" /><path d="M10.5 13.5v-1a1.5 1.5 0 0 1 3 0v1" />{dot(12, 15.9, 0.9)}</>,
);

/* ---- files and documents ---- */
export const FileText = make('FileText', <><path d={FILE} /><path d={FOLD} /><path d="M8.5 12.5h7M8.5 16.5h4.5" />{dot(15.8, 16.5, 1)}</>);
export const FileArchive = make(
  'FileArchive',
  <><path d={FILE} /><path d={FOLD} /><path d="M10 5.5v.5M10 8.5v.5M10 11.5v.5" /><rect x="8.5" y="14" width="3" height="4" rx="0.8" style={ACC} /></>,
);
export const Receipt = make(
  'Receipt',
  <><path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z" /><path d="M9 8h6M9 12h6M11.5 16H15" />{dot(9, 16, 1)}</>,
);
export const ListOrdered = make(
  'ListOrdered',
  <><path d="M10 6h10M10 12h10M10 18h10" />{dot(5, 6, 1.5)}<circle cx="5" cy="12" r="1.25" style={INK} /><circle cx="5" cy="18" r="1.25" style={INK} /></>,
);
export const PenLine = make(
  'PenLine',
  <><path d="M15 5l4 4-9.5 9.5H5.5v-4z" /><path d="M12.8 7.2l4 4M13 20.5h7" /><path d="M5.5 18.5V16l2.5 2.5z" style={ACC} /></>,
);
export const Save = make(
  'Save',
  <><path d="M5 3.5h11l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5z" /><path d="M7.5 3.5V8h7V3.5M7.5 20.5v-6h9v6" /><rect x="11.5" y="4.8" width="1.8" height="2" rx="0.4" style={ACC} /></>,
);

/* ---- code ---- */
export const Binary = make(
  'Binary',
  <><path d="M7 4v6M5.5 5L7 4" /><rect x="14" y="4" width="4.5" height="6" rx="2" /><rect x="5" y="14" width="4.5" height="6" rx="2" /><path d="M17 14v6M15.5 15l1.5-1" style={ACC_STROKE} /></>,
);
export const Braces = make(
  'Braces',
  <><path d="M8 4H7a2 2 0 0 0-2 2v3.5L3.5 12 5 14.5V18a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v3.5l1.5 2.5-1.5 2.5V18a2 2 0 0 1-2 2h-1" />{dot(12, 12, 1.5)}</>,
);
export const CodeXml = make('CodeXml', <><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /><path d="M13.5 5l-3 14" style={ACC_STROKE} /></>);
export const SquareTerminal = make(
  'SquareTerminal',
  <><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><path d="M7.5 9l3 3-3 3" /><path d="M13 15h3.5" style={ACC_STROKE} /></>,
);

/* ---- money ---- */
export const Coins = make(
  'Coins',
  <><circle cx="9" cy="9" r="6" /><path d="M18.6 10.6a6 6 0 1 1-8 8" /><path d="M9 6.4L11.6 9 9 11.6 6.4 9z" style={ACC} /></>,
);
export const Wallet = make(
  'Wallet',
  <><rect x="3.5" y="6.5" width="17" height="13" rx="2.5" /><path d="M6 6.5l9.5-3 1.5 3M20.5 10.5h-4a2.5 2.5 0 0 0 0 5h4" />{dot(16.8, 13, 1.15)}</>,
);
export const QrCode = make(
  'QrCode',
  <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><path d="M13.5 13.5h3v3M20.5 13.5v1M13.5 20.5h3M19.5 17.5v3h-1" />{dot(7, 7, 1.15)}</>,
);

/* ---- hardware and network ---- */
export const Cpu = make(
  'Cpu',
  <><rect x="5.5" y="5.5" width="13" height="13" rx="2.5" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" style={ACC} /><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3" /></>,
);
export const Server = make(
  'Server',
  <><rect x="4" y="4" width="16" height="7" rx="2" /><rect x="4" y="13" width="16" height="7" rx="2" /><path d="M12 7.5h4.5M12 16.5h4.5" />{dot(7.5, 7.5, 1.2)}<circle cx="7.5" cy="16.5" r="1.1" style={INK} /></>,
);
export const Laptop = make(
  'Laptop',
  <><rect x="5" y="5" width="14" height="10.5" rx="1.5" /><path d="M2.5 19.5h19M5 15.5l-2 4M19 15.5l2 4" />{dot(12, 10.25, 1.2)}</>,
);
export const Box = make('Box', <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" />{dot(12, 7.5, 1.2)}</>);
export const Blocks = make(
  'Blocks',
  <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="14.5" y="4.5" width="5" height="5" rx="1" style={ACC} /></>,
);
export const Route = make('Route', <><path d="M8.5 19H16l3-3v-1l-3-3H8l-3-3V8l3-3h7.5" /><circle cx="6" cy="19" r="2.4" /><circle cx="18" cy="5" r="2.4" style={ACC} /></>);
export const Waypoints = make(
  'Waypoints',
  <><circle cx="5" cy="12" r="2.2" /><circle cx="12" cy="5" r="2.2" /><circle cx="19" cy="12" r="2.2" /><circle cx="12" cy="19" r="2.2" style={ACC} /><path d="M6.6 10.4l3.8-3.8M13.6 6.6l3.8 3.8M17.4 13.6l-3.6 3.6" /></>,
);
export const Radio = make(
  'Radio',
  <>{dot(12, 12, 2)}<path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></>,
);
export const Settings2 = make(
  'Settings2',
  <><path d="M4 7h9M18.5 7H20M4 17h3M12 17h8" /><circle cx="15.5" cy="7" r="2.3" style={ACC} /><circle cx="9.5" cy="17" r="2.3" /></>,
);

/* ---- work and time ---- */
export const Activity = make('Activity', <><path d="M3 12h4l2.5-6 5 12 2.5-6h2.2" />{dot(20.6, 12, 1.4)}</>);
export const HeartPulse = make('HeartPulse', <><path d={HEART} /><path d="M7 12.5h2.5l1.3-2.5 2.4 4.5 1.3-2h2.5" style={ACC_STROKE} /></>);
export const HeartOff = make('HeartOff', <><path d={HEART} /><path d="M3.5 3.5l17 17" /></>);
export const Hourglass = make(
  'Hourglass',
  <><path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5v3L12 12l-4.5 5.5v3M16.5 3.5v3L12 12l4.5 5.5v3" /><path d="M9.3 19.6L12 17l2.7 2.6z" style={ACC} /></>,
);
export const Timer = make('Timer', <><circle cx="12" cy="13.5" r="7.5" /><path d="M10 2.5h4M12 13.5V9.5M18 7.5l1.2-1.2" />{dot(12, 13.5, 1.3)}</>);
export const Gauge = make('Gauge', <><path d="M4.6 17.5a8.5 8.5 0 1 1 14.8 0" /><path d="M12 14.5l4-4.5" />{dot(12, 14.5, 1.7)}</>);
export const Briefcase = make(
  'Briefcase',
  <><rect x="3.5" y="7" width="17" height="12.5" rx="2" /><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h7M13.5 12.5h7" /><rect x="10.5" y="11" width="3" height="3" rx="0.6" style={ACC} /></>,
);
export const Inbox = make(
  'Inbox',
  <><path d="M3.5 13l3-7.5h11l3 7.5v5.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5z" /><path d="M3.5 13H8l1.5 2.5h5L16 13h4.5" />{dot(12, 9.3, 1.2)}</>,
);
export const Pin = make('Pin', <><path d="M8 3.5h8M9.5 3.5V9L6 13.5V16h12v-2.5L14.5 9V3.5M12 16v3" />{dot(12, 20.6, 1.3)}</>);
export const FlaskConical = make(
  'FlaskConical',
  <><path d="M9.5 3.5h5M10.5 3.5v6L4.8 18.4A1.5 1.5 0 0 0 6.1 20.5h11.8a1.5 1.5 0 0 0 1.3-2.1L13.5 9.5v-6M7.3 15h9.4" />{dot(12, 17.7, 1.15)}</>,
);
