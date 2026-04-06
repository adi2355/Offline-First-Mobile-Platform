const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T/;
const YYYY_MM_DD_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export function canonicalizeCalendarDate(dateStr: string): string {
  if (YYYY_MM_DD_REGEX.test(dateStr)) {
    return dateStr;
  }
  if (ISO_DATETIME_REGEX.test(dateStr)) {
    return dateStr.substring(0, 10);
  }
  throw new Error(
    `canonicalizeCalendarDate: unexpected date format "${dateStr}". ` +
    `Expected YYYY-MM-DD or ISO datetime (YYYY-MM-DDThh:mm:ss.sssZ).`
  );
}
