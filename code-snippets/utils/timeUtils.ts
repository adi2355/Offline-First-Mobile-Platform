export function getTodayRangeLocal(): { startDate: Date, endDate: Date } {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0); 
  const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999); 
  console.log(`[timeUtils] Today Range (Local): ${startDate.toISOString()} to ${endDate.toISOString()}`);
  return { startDate, endDate };
}
export function getCurrentWeekProgressRangeLocal(weekStartsOnSunday: boolean = true): { startDate: Date, endDate: Date } {
  const now = new Date();
  const currentDayOfWeek = now.getDay(); 
  const startDate = new Date(now);
  const dayOffset = weekStartsOnSunday ? currentDayOfWeek : (currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1);
  startDate.setDate(now.getDate() - dayOffset);
  startDate.setHours(0, 0, 0, 0); 
  const endDate = new Date(); 
  endDate.setHours(23, 59, 59, 999);
  console.log(`[timeUtils] Current Week Progress Range (Local): ${startDate.toISOString()} to ${endDate.toISOString()}`);
  return { startDate, endDate };
}
export function getCurrentFullWeekRangeLocal(weekStartsOnSunday: boolean = true): { startDate: Date, endDate: Date } {
  const { startDate: startOfWeek } = getCurrentWeekProgressRangeLocal(weekStartsOnSunday);
  const endDate = new Date(startOfWeek);
  endDate.setDate(startOfWeek.getDate() + 6); 
  endDate.setHours(23, 59, 59, 999);
  console.log(`[timeUtils] Current Full Week Range (Local): ${startOfWeek.toISOString()} to ${endDate.toISOString()}`);
  return { startDate: startOfWeek, endDate };
}
export function getLastNDaysRangeLocal(days: number): { startDate: Date, endDate: Date } {
  const endDate = new Date(); 
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - (days - 1)); 
  startDate.setHours(0, 0, 0, 0); 
  console.log(`[timeUtils] Last ${days} Days Range (Local): ${startDate.toISOString()} to ${endDate.toISOString()}`);
  return { startDate, endDate };
} 