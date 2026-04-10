import {
  type MergeContext,
  type MergeResult,
} from '@shared/contracts';
export interface JournalReactions {
  [key: string]: unknown;
}
export interface JournalEntryMergeData {
  id: string;
  userId: string;
  clientEntryId?: string | null;
  title?: string | null;
  content: string;
  mood?: string | null;
  tags?: string[] | null;
  isPrivate?: boolean;
  sessionId?: string | null;
  consumptionId?: string | null;
  productId?: string | null;
  reactions?: JournalReactions | null;
  entryDate?: string | null;
  entryType?: string | null;
  overallMood?: number | null;
  energyLevel?: number | null;
  focusLevel?: number | null;
  creativityLevel?: number | null;
  socialComfort?: number | null;
  sleepQuality?: number | null;
  appetiteLevel?: number | null;
  symptomsBefore?: string[] | null;
  symptomsAfter?: string[] | null;
  painAreas?: string[] | null;
  photoUrls?: string[] | null;
  voiceMemoUrl?: string | null;
  weather?: Record<string, unknown> | null;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}
function parseTimestamp(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return isNaN(parsed) ? null : parsed;
}
function unionArrays<T>(
  arr1: T[] | null | undefined,
  arr2: T[] | null | undefined
): T[] {
  const localArray = Array.isArray(arr1) ? arr1 : [];
  const serverArray = Array.isArray(arr2) ? arr2 : [];
  return Array.from(new Set([...localArray, ...serverArray]));
}
function deepMerge(
  local: JournalReactions | null,
  server: JournalReactions | null
): JournalReactions | null {
  if (!local && !server) return null;
  if (!local) return server;
  if (!server) return local;
  return { ...server, ...local };
}
function resolveByTimestamp<T>(
  localValue: T,
  serverValue: T,
  localTime: number | null,
  serverTime: number | null
): { value: T; source: 'local' | 'server' } {
  if (localTime === null && serverTime === null) {
    return { value: localValue ?? serverValue, source: localValue !== undefined ? 'local' : 'server' };
  }
  if (localTime === null) {
    return { value: serverValue ?? localValue, source: 'server' };
  }
  if (serverTime === null) {
    return { value: localValue ?? serverValue, source: 'local' };
  }
  const preferred = localTime > serverTime ? localValue : serverValue;
  if (preferred !== undefined && preferred !== null) {
    return { value: preferred, source: localTime > serverTime ? 'local' : 'server' };
  }
  return { value: localTime > serverTime ? serverValue : localValue, source: localTime > serverTime ? 'server' : 'local' };
}
export function mergeJournalEntry(
  local: JournalEntryMergeData,
  server: JournalEntryMergeData,
  context: MergeContext
): MergeResult<JournalEntryMergeData> {
  const resolvedFromLocal: string[] = [];
  const resolvedFromServer: string[] = [];
  const mergedFields: string[] = [];
  const merged: JournalEntryMergeData = { ...local };
  const localTime = parseTimestamp(context.localUpdatedAt);
  const serverTime = parseTimestamp(context.serverUpdatedAt);
  merged.id = server.id;
  resolvedFromServer.push('id');
  merged.userId = server.userId;
  resolvedFromServer.push('userId');
  merged.sessionId = server.sessionId ?? local.sessionId;
  if (server.sessionId !== undefined) {
    resolvedFromServer.push('sessionId');
  } else {
    resolvedFromLocal.push('sessionId');
  }
  merged.consumptionId = server.consumptionId ?? local.consumptionId;
  if (server.consumptionId !== undefined) {
    resolvedFromServer.push('consumptionId');
  } else {
    resolvedFromLocal.push('consumptionId');
  }
  const titleResult = resolveByTimestamp(local.title, server.title, localTime, serverTime);
  merged.title = titleResult.value;
  (titleResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('title');
  const contentResult = resolveByTimestamp(local.content, server.content, localTime, serverTime);
  merged.content = contentResult.value;
  (contentResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('content');
  const moodResult = resolveByTimestamp(local.mood, server.mood, localTime, serverTime);
  merged.mood = moodResult.value;
  (moodResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('mood');
  const productIdResult = resolveByTimestamp(local.productId, server.productId, localTime, serverTime);
  merged.productId = productIdResult.value;
  (productIdResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('productId');
  merged.tags = unionArrays(local.tags, server.tags);
  mergedFields.push('tags');
  merged.isPrivate = local.isPrivate;
  resolvedFromLocal.push('isPrivate');
  merged.reactions = deepMerge(local.reactions ?? null, server.reactions ?? null);
  if (local.reactions && server.reactions) {
    mergedFields.push('reactions');
  } else if (local.reactions) {
    resolvedFromLocal.push('reactions');
  } else {
    resolvedFromServer.push('reactions');
  }
  const entryDateResult = resolveByTimestamp(local.entryDate, server.entryDate, localTime, serverTime);
  merged.entryDate = entryDateResult.value;
  (entryDateResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('entryDate');
  const entryTypeResult = resolveByTimestamp(local.entryType, server.entryType, localTime, serverTime);
  merged.entryType = entryTypeResult.value;
  (entryTypeResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('entryType');
  const overallMoodResult = resolveByTimestamp(local.overallMood, server.overallMood, localTime, serverTime);
  merged.overallMood = overallMoodResult.value;
  (overallMoodResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('overallMood');
  const energyLevelResult = resolveByTimestamp(local.energyLevel, server.energyLevel, localTime, serverTime);
  merged.energyLevel = energyLevelResult.value;
  (energyLevelResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('energyLevel');
  const focusLevelResult = resolveByTimestamp(local.focusLevel, server.focusLevel, localTime, serverTime);
  merged.focusLevel = focusLevelResult.value;
  (focusLevelResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('focusLevel');
  const creativityLevelResult = resolveByTimestamp(local.creativityLevel, server.creativityLevel, localTime, serverTime);
  merged.creativityLevel = creativityLevelResult.value;
  (creativityLevelResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('creativityLevel');
  const socialComfortResult = resolveByTimestamp(local.socialComfort, server.socialComfort, localTime, serverTime);
  merged.socialComfort = socialComfortResult.value;
  (socialComfortResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('socialComfort');
  const sleepQualityResult = resolveByTimestamp(local.sleepQuality, server.sleepQuality, localTime, serverTime);
  merged.sleepQuality = sleepQualityResult.value;
  (sleepQualityResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('sleepQuality');
  const appetiteLevelResult = resolveByTimestamp(local.appetiteLevel, server.appetiteLevel, localTime, serverTime);
  merged.appetiteLevel = appetiteLevelResult.value;
  (appetiteLevelResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('appetiteLevel');
  const symptomsBeforeResult = resolveByTimestamp(local.symptomsBefore, server.symptomsBefore, localTime, serverTime);
  merged.symptomsBefore = symptomsBeforeResult.value;
  (symptomsBeforeResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('symptomsBefore');
  const symptomsAfterResult = resolveByTimestamp(local.symptomsAfter, server.symptomsAfter, localTime, serverTime);
  merged.symptomsAfter = symptomsAfterResult.value;
  (symptomsAfterResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('symptomsAfter');
  const painAreasResult = resolveByTimestamp(local.painAreas, server.painAreas, localTime, serverTime);
  merged.painAreas = painAreasResult.value;
  (painAreasResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('painAreas');
  merged.photoUrls = unionArrays(local.photoUrls, server.photoUrls);
  mergedFields.push('photoUrls');
  const voiceMemoUrlResult = resolveByTimestamp(local.voiceMemoUrl, server.voiceMemoUrl, localTime, serverTime);
  merged.voiceMemoUrl = voiceMemoUrlResult.value;
  (voiceMemoUrlResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('voiceMemoUrl');
  const weatherResult = resolveByTimestamp(local.weather, server.weather, localTime, serverTime);
  merged.weather = weatherResult.value;
  (weatherResult.source === 'local' ? resolvedFromLocal : resolvedFromServer).push('weather');
  merged.clientEntryId = local.clientEntryId ?? server.clientEntryId;
  if (local.clientEntryId) {
    resolvedFromLocal.push('clientEntryId');
  } else {
    resolvedFromServer.push('clientEntryId');
  }
  const newVersion = Math.max(context.localVersion, context.serverVersion) + 1;
  merged.version = newVersion;
  merged.createdAt = server.createdAt ?? local.createdAt;
  merged.updatedAt = context.now;
  return {
    data: merged,
    version: newVersion,
    resolvedFromLocal: Object.freeze(resolvedFromLocal),
    resolvedFromServer: Object.freeze(resolvedFromServer),
    mergedFields: Object.freeze(mergedFields),
    updatedAt: context.now,
  };
}
