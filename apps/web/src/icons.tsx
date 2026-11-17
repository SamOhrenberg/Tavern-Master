import type { ReactNode, SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement>;

const icon = (children: ReactNode) =>
  function Icon(props: Props) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {children}
      </svg>
    );
  };

export const IconBack = icon(<path d="M15 5l-7 7 7 7" />);
export const IconChevron = icon(<path d="M9 5l7 7-7 7" />);
export const IconChevronDown = icon(<path d="M5 9l7 7 7-7" />);
export const IconClose = icon(<path d="M6 6l12 12M18 6L6 18" />);
export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);
export const IconCheck = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconSend = icon(<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />);
export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </>,
);
export const IconCopy = icon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
  </>,
);
export const IconTrash = icon(<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" />);
export const IconUpload = icon(<path d="M12 16V4M7 9l5-5 5 5M5 20h14" />);
export const IconLogout = icon(
  <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16l4-4-4-4M14 12H4" />,
);

/** A twenty-sided die: the app's mark and the DM's avatar. */
export const IconD20 = icon(
  <>
    <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z" />
    <path d="M12 2.5L7.4 14.3h9.2zM3.8 7.25L7.4 14.3l-3.6 2.45M20.2 7.25L16.6 14.3l3.6 2.45M7.4 14.3L12 21.5l4.6-7.2" />
  </>,
);
export const IconCampfire = icon(
  <>
    <path d="M12 3c.5 2.6 3.5 4 3.5 7.2A3.5 3.5 0 0 1 12 13.7a3.5 3.5 0 0 1-3.5-3.5c0-1.4.7-2.3 1.4-3 .2 1 .7 1.6 1.3 1.8C11 7.200 11.300 5 12 3z" />
    <path d="M4 20.500l16-4.500M4 16l16 4.500" />
  </>,
);
export const IconUsers = icon(
  <>
    <circle cx="9" cy="8.500" r="3.200" />
    <path d="M3 19.500c.4-3.300 2.900-5.200 6-5.200s5.600 1.900 6 5.200M16 5.600a3.200 3.200 0 0 1 0 5.800M17.600 14.700c1.900.6 3.100 2.200 3.400 4.800" />
  </>,
);
export const IconBook = icon(
  <>
    <path d="M12 6.500C10.300 5.200 7.900 4.500 4.500 4.500v13c3.400 0 5.800.7 7.500 2 1.700-1.300 4.100-2 7.500-2v-13c-3.400 0-5.800.7-7.500 2z" />
    <path d="M12 6.500v13" />
  </>,
);
export const IconCog = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21M5.600 5.600l1.800 1.800M16.600 16.600l1.800 1.800M5.600 18.400l1.800-1.800M16.600 7.400l1.800-1.800" />
  </>,
);
export const IconShield = icon(
  <>
    <path d="M12 3l7.500 2.800v5.700c0 4.400-3 7.900-7.500 9.500-4.500-1.600-7.500-5.100-7.500-9.500V5.800z" />
    <path d="M9 12l2.200 2.200L15.200 10" />
  </>,
);
export const IconScroll = icon(
  <>
    <path d="M7 4h10.500A2.500 2.500 0 0 1 20 6.500V8h-3" />
    <path d="M17 6.500V18a2.500 2.500 0 0 1-2.500 2.500h-9A2.500 2.500 0 0 1 3 18v-1.500h11V18a2.500 2.500 0 0 0 .7 1.700M7 4a2 2 0 0 0-2 2v10.500M8.500 9h5M8.500 12.500h5" />
  </>,
);
export const IconSwords = icon(
  <path d="M4 4l9.500 9.500M4 4v3.500L12 15.500M4 4h3.500l8 8M20 4l-9.500 9.500M20 4v3.500l-2.200 2.200M20 4h-3.500l-2.200 2.200M6.500 14.500l3 3M5 19l3-3M17.500 14.500l-3 3M19 19l-3-3" />,
);
export const IconChat = icon(<path d="M4.500 5.500h15v10h-8L7 19.500v-4H4.500z" />);
export const IconHeart = icon(
  <path d="M12 19.500C6.500 15.500 4 12.700 4 9.500A4 4 0 0 1 12 8a4 4 0 0 1 8 1.500c0 3.200-2.500 6-8 10z" />,
);
export const IconBackpack = icon(
  <>
    <path d="M7 8.500a5 5 0 0 1 10 0v10a1.500 1.500 0 0 1-1.500 1.500h-7A1.500 1.500 0 0 1 7 18.500zM9.500 5V4a2.500 2.500 0 0 1 5 0v1" />
    <path d="M9.500 13h5v3h-5zM4.500 12v5M19.500 12v5" />
  </>,
);
export const IconMap = icon(<path d="M9 5L3.500 7v12L9 17l6 2 5.500-2V5L15 7zM9 5v12M15 7v12" />);
export const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="8.500" />
    <path d="M12 7.500V12l3 2" />
  </>,
);
export const IconKey = icon(
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l8.500-8.500M16 7l2.500 2.500M13.500 9.500l2 2" />
  </>,
);
export const IconGavel = icon(<path d="M8.500 9.500l5-5 4 4-5 5zM10.500 11.500L4 18M13 20h7" />);
export const IconCrown = icon(<path d="M4 17.500L3 8l5 3.500L12 5l4 6.500L21 8l-1 9.500zM4 20.500h16" />);
export const IconSparkle = icon(
  <path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800zM19 16l.7 2.300L22 19l-2.300.7L19 22l-.7-2.300L16 19l2.300-.7z" />,
);
export const IconAlert = icon(
  <>
    <path d="M12 4l9 15.500H3z" />
    <path d="M12 10v4.500M12 17.200v.1" />
  </>,
);
export const IconPhone = icon(
  <>
    <rect x="6.500" y="2.500" width="11" height="19" rx="2.800" />
    <path d="M10.500 5.500h3" />
  </>,
);
/** The iOS share glyph (box with an arrow leaving the top). */
export const IconShareIos = icon(
  <path d="M12 15V3.500M8 7l4-4 4 4M8.500 10.500H7A1.500 1.500 0 0 0 5.500 12v7A1.500 1.500 0 0 0 7 20.500h10a1.500 1.500 0 0 0 1.500-1.500v-7a1.500 1.500 0 0 0-1.500-1.500h-1.500" />,
);
/** "Add to Home Screen" glyph (rounded square with a plus). */
export const IconAddSquare = icon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="M12 8.500v7M8.500 12h7" />
  </>,
);
export const IconDots = icon(
  <>
    <circle cx="6" cy="12" r="1.200" fill="currentColor" />
    <circle cx="12" cy="12" r="1.200" fill="currentColor" />
    <circle cx="18" cy="12" r="1.200" fill="currentColor" />
  </>,
);
export const IconFeedback = icon(
  <>
    <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-7.5L7 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z" />
    <path d="M12 8v3.5M12 13.8v.01" />
  </>,
);
export const IconImage = icon(
  <>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 16l-5-5-8.5 8" />
  </>,
);
export const IconScreen = icon(
  <>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.2" />
    <path d="M10.5 18.5h3" />
  </>,
);
