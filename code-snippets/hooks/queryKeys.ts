import type { ConsumptionListParams } from '../repositories/ConsumptionRepository';
const omitBustCache = (params: ConsumptionListParams): Omit<ConsumptionListParams, 'bustCache'> => {
  const { bustCache, ...rest } = params;
  return rest;
};
export const consumptionKeys = {
  all: ['consumptions'] as const,
  lists: () => [...consumptionKeys.all, 'list'] as const,
  list: (params: ConsumptionListParams) => [...consumptionKeys.lists(), omitBustCache(params)] as const,
  listWithMeta: (params: ConsumptionListParams) => [...consumptionKeys.lists(), 'meta', omitBustCache(params)] as const,
  stats: () => [...consumptionKeys.all, 'stats'] as const,
  count: () => [...consumptionKeys.stats(), 'count'] as const,
  details: () => [...consumptionKeys.all, 'detail'] as const,
  detail: (id: string) => [...consumptionKeys.details(), id] as const,
};
export const sessionKeys = {
  all: ['sessions'] as const,
  lists: () => [...sessionKeys.all, 'list'] as const,
  list: (params?: { page?: number; limit?: number }) => [...sessionKeys.lists(), params] as const,
  details: () => [...sessionKeys.all, 'detail'] as const,
  detail: (id: string) => [...sessionKeys.details(), id] as const,
  active: () => [...sessionKeys.all, 'active'] as const,
};
export const journalKeys = {
  all: ['journal'] as const,
  lists: () => [...journalKeys.all, 'list'] as const,
  list: (params?: { page?: number; limit?: number; startDate?: string; endDate?: string }) =>
    [...journalKeys.lists(), params] as const,
  details: () => [...journalKeys.all, 'detail'] as const,
  detail: (id: string) => [...journalKeys.details(), id] as const,
};
export const productKeys = {
  all: ['products'] as const,
  lists: () => [...productKeys.all, 'list'] as const,
  list: (params?: { page?: number; limit?: number; type?: string }) =>
    [...productKeys.lists(), params] as const,
  details: () => [...productKeys.all, 'detail'] as const,
  detail: (id: string) => [...productKeys.details(), id] as const,
  popular: () => [...productKeys.all, 'popular'] as const,
  search: (query: string) => [...productKeys.all, 'search', query] as const,
};
export const analyticsKeys = {
  all: ['analytics'] as const,
  daily: () => [...analyticsKeys.all, 'daily'] as const,
  dailyRange: (startDate: string, endDate: string) =>
    [...analyticsKeys.daily(), { startDate, endDate }] as const,
  weekly: () => [...analyticsKeys.all, 'weekly'] as const,
  monthly: () => [...analyticsKeys.all, 'monthly'] as const,
  summary: () => [...analyticsKeys.all, 'summary'] as const,
  dashboard: (timezone?: string) => [...analyticsKeys.all, 'dashboard', timezone ?? 'default'] as const,
};
export const achievementKeys = {
  all: ['achievements'] as const,
  user: () => [...achievementKeys.all, 'user'] as const,
  unlocked: () => [...achievementKeys.all, 'unlocked'] as const,
  progress: () => [...achievementKeys.all, 'progress'] as const,
};
export const deviceKeys = {
  all: ['devices'] as const,
  lists: () => [...deviceKeys.all, 'list'] as const,
  list: (params?: { status?: string }) => [...deviceKeys.lists(), params] as const,
  details: () => [...deviceKeys.all, 'detail'] as const,
  detail: (id: string) => [...deviceKeys.details(), id] as const,
  connected: () => [...deviceKeys.all, 'connected'] as const,
};
const resolveUserKey = (userId: string | null) => userId ?? 'anonymous';
export const userKeys = {
  all: ['user'] as const,
  profile: (userId: string | null) => [...userKeys.all, 'profile', resolveUserKey(userId)] as const,
  preferences: (userId: string | null) => [...userKeys.all, 'preferences', resolveUserKey(userId)] as const,
  subscription: (userId: string | null) => [...userKeys.all, 'subscription', resolveUserKey(userId)] as const,
  stats: (userId: string | null) => [...userKeys.all, 'stats', resolveUserKey(userId)] as const,
};
export const healthProjectionKeys = {
  all: ['healthProjection'] as const,
  rollups: () => [...healthProjectionKeys.all, 'rollups'] as const,
  rollupsByMetric: (metricCode: string, startDate: string, endDate: string) =>
    [...healthProjectionKeys.rollups(), { metricCode, startDate, endDate }] as const,
  sleep: () => [...healthProjectionKeys.all, 'sleep'] as const,
  sleepByRange: (startDate: string, endDate: string) =>
    [...healthProjectionKeys.sleep(), { startDate, endDate }] as const,
  sleepByNight: (nightLocalDate: string) =>
    [...healthProjectionKeys.sleep(), 'night', nightLocalDate] as const,
  sessionImpact: () => [...healthProjectionKeys.all, 'sessionImpact'] as const,
  sessionImpactById: (sessionId: string) =>
    [...healthProjectionKeys.sessionImpact(), sessionId] as const,
  productImpact: () => [...healthProjectionKeys.all, 'productImpact'] as const,
  productImpactByMetric: (metricCode: string, periodDays: number) =>
    [...healthProjectionKeys.productImpact(), { metricCode, periodDays }] as const,
  insights: () => [...healthProjectionKeys.all, 'insights'] as const,
  insightsByDomain: (domain: string, startDate: string, endDate: string) =>
    [...healthProjectionKeys.insights(), { domain, startDate, endDate }] as const,
};
