import type { ReactNode } from 'react';

export type SerialAssistantIconName = 'connection' | 'refresh' | 'chevron' | 'send' | 'search' | 'pause' | 'play' | 'record' | 'clear' | 'download' | 'folder' | 'save' | 'close' | 'timer';

export default function SerialAssistantIcon({ name }: { name: SerialAssistantIconName }) {
  const paths: Record<SerialAssistantIconName, ReactNode> = {
    connection: <path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4m-4-4h8" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M5.5 8a7 7 0 0 1 11.7-3L20 8M4 16l2.8 3A7 7 0 0 0 18.5 16" />,
    chevron: <path d="m7 10 5 5 5-5" />,
    send: <path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    pause: <path d="M7 5h3v14H7zM14 5h3v14h-3z" />,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    record: <circle cx="12" cy="12" r="8" />,
    clear: <path d="m15 3 6 6-11 12H6l-4-4L15 3ZM8 11l6 6M10 21h11" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    folder: <path d="M3 8V5h6l3 3h9v3M3 8v12h16l3-9H7l-4 9" />,
    save: <path d="M6 3h12v18l-6-4-6 4V3Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    timer: <><circle cx="12" cy="14" r="7" /><path d="M12 10v5l3 2M9 3h6m-3 0v4m5 1 2-2" /></>,
  };
  return <svg className="serial-assistant-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
