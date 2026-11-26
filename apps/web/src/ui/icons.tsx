function Icon({ size = 20, d }: { size?: number; d: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width={size} height={size}>
      <path fill="currentColor" d={d} />
    </svg>
  );
}

export function MicIcon({ muted = false, size = 20 }: { muted?: boolean; size?: number }) {
  return muted ? (
    <Icon
      size={size}
      d="M19 11h-1.7a5.4 5.4 0 0 1-.57 2.4l1.23 1.23A7 7 0 0 0 19 11ZM15 11.16V5a3 3 0 0 0-5.94-.6L15 10.34v.82ZM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.4 2.65l1.66 1.66A5.3 5.3 0 0 1 12 16.3 5.3 5.3 0 0 1 6.7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 2.53-.82L19.73 21 21 19.73 4.27 3Z"
    />
  ) : (
    <Icon size={size} d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z" />
  );
}

export function HangUpIcon() {
  return (
    <Icon
      size={30}
      d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.47a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9Z"
    />
  );
}

export function PhoneIcon({ size = 28 }: { size?: number }) {
  return (
    <Icon
      size={size}
      d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.58a1 1 0 0 1-.25 1.01l-2.2 2.2Z"
    />
  );
}

export function SpeakerIcon({ on }: { on: boolean }) {
  return on ? (
    <Icon d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4ZM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54Z" />
  ) : (
    <Icon d="M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z" />
  );
}

export function HammerIcon({ size = 20 }: { size?: number }) {
  return <Icon size={size} d="m13.8 3.2 1.4 1.4-1.1 1.1 4.2 4.2 1.1-1.1 1.4 1.4-3.5 3.5-1.4-1.4 1.1-1.1-1.4-1.4-8.5 8.5a1 1 0 0 1-1.4 0l-1.4-1.4a1 1 0 0 1 0-1.4l8.5-8.5-1.4-1.4-1.1 1.1-1.4-1.4z" />;
}

export function GearIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon
      size={size}
      d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z"
    />
  );
}

export function ChatIcon({ size = 24 }: { size?: number }) {
  return <Icon size={size} d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z" />;
}

export function WaveIcon({ size = 24 }: { size?: number }) {
  return <Icon size={size} d="M7 9h2v6H7V9Zm4-4h2v14h-2V5Zm4 2h2v10h-2V7ZM3 11h2v2H3v-2Zm16 0h2v2h-2v-2Z" />;
}

export function ArrowDownIcon({ size = 20 }: { size?: number }) {
  return <Icon size={size} d="M11 4h2v12.2l5.3-5.3 1.4 1.4-7.7 7.7-7.7-7.7 1.4-1.4 5.3 5.3V4Z" />;
}

export function TransferIcon({ size = 20 }: { size?: number }) {
  return <Icon size={size} d="M7 3 2.5 7.5h3.5V15h2V7.5h3.5L7 3Zm10 18 4.5-4.5H18V9h-2v7.5h-3.5L17 21Z" />;
}
