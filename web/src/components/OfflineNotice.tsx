interface Props {
  show: boolean;
}

export function OfflineNotice({ show }: Props) {
  if (!show) return null;
  return (
    <p className="offline-notice" role="status">
      Offline demo data — the API on :5174 is unreachable, so saved sample answers are shown.
    </p>
  );
}
