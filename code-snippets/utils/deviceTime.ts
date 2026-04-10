export function formatDeviceLastSeen(
  timestampMs: number | string | null | undefined,
): string {
  if (timestampMs == null) return 'Never';
  const ms = typeof timestampMs === 'string'
    ? new Date(timestampMs).getTime()
    : timestampMs;
  if (Number.isNaN(ms) || ms === 0) return 'Never';
  const now = Date.now();
  const diffMs = now - ms;
  if (diffMs < 0) return 'Just now';
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour} ${diffHour === 1 ? 'hour' : 'hours'} ago`;
  const todayDate = new Date(now);
  const thenDate = new Date(ms);
  const todayStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
  const thenStart = new Date(thenDate.getFullYear(), thenDate.getMonth(), thenDate.getDate());
  const dayDiff = Math.floor(
    (todayStart.getTime() - thenStart.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (dayDiff === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  const month = thenDate.toLocaleDateString(undefined, { month: 'short' });
  const day = thenDate.getDate();
  if (thenDate.getFullYear() === todayDate.getFullYear()) {
    return `${month} ${day}`;
  }
  return `${month} ${day}, ${thenDate.getFullYear()}`;
}
export function formatMacSuffix(mac: string | null | undefined): string {
  if (!mac) return '';
  const parts = mac.split(':');
  if (parts.length < 2) return mac;
  return parts.slice(-2).join(':');
}
export function formatDurationMs(ms: number): string {
  if (!ms || ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
