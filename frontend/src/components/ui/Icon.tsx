/* A small inline icon set (24px grid, stroked) so no icon library is needed. */
const paths = {
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6 6 18",
  home: "M4 11 12 4l8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z",
  file: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14",
  folder:
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.25a2.5 2.5 0 1 1 3.5 2.3c-.6.27-1 .87-1 1.53V14M12 17.25v.01",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  arrowLeft: "M19 12H5M11 6l-6 6 6 6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7",
  alert: "M12 3.5 21.5 20h-19zM12 10v4.5M12 17.25v.01",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.75v.01",
  xCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  calendar: "M4 6h16v15H4zM4 10h16M8 3v4M16 3v4",
  upload: "M12 15V4M7 9l5-5 5 5M4 15v5h16v-5",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  send: "M4 12 20 4l-6 16-2.5-6.5z",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
} as const

export type IconName = keyof typeof paths

interface IconProps {
  name: IconName
  className?: string
}

export default function Icon({ name, className = "size-5" }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={paths[name]} />
    </svg>
  )
}
