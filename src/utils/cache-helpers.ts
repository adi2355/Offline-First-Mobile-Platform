export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i); 
  }
  return Math.abs(hash).toString(16);
}
export function hashQueryKey(queryKey: string): string {
  return hashString(queryKey);
}
export function matchesQueryKeyPrefix(queryKey: string, prefix: string): boolean {
  return queryKey.startsWith(prefix);
}
export function extractEntityType(queryKey: string): string | null {
  try {
    if (queryKey.startsWith('[')) {
      const parsed = JSON.parse(queryKey);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return String(parsed[0]);
      }
    } else {
      const parts = queryKey.split('-');
      if (parts.length > 0) {
        return parts[0] ?? null;
      }
    }
  } catch (error) {
  }
  return null;
}
