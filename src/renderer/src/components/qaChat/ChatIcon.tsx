import type { ReactNode } from 'react'

type IconName = 'history' | 'new-chat' | 'close' | 'plus' | 'send' | 'stop' | 'desktop' | 'tablet' | 'mobile' | 'unavailable' | 'more' | 'filter' | 'tracker' | 'refresh' | 'import' | 'search' | 'check' | 'image' | 'commands' | 'copy'
const paths: Record<IconName, ReactNode> = {
  history: <><path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7"/><path d="M12 7v5l3 2"/></>,
  'new-chat': <><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"/><path d="m16 3 5 5-10 10-5 1 1-5Z"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  send: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>,
  desktop: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v3m-4 0h8"/></>,
  tablet: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/></>,
  mobile: <><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></>,
  unavailable: <><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  filter: <><path d="M3 6h18M3 12h18M3 18h18"/><path d="M7 3v6m10 0v6M9 15v6"/></>,
  tracker: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></>,
  refresh: <><path d="M20 7a8 8 0 1 0 0 10M20 3v5h-5"/></>,
  import: <><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 4-7 5 8"/></>,
  commands: <path d="M8 3 5 21M19 3l-3 18M3 8h18M2 16h18"/>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
}

export default function ChatIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
