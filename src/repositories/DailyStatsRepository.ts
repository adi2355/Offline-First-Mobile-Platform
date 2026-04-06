import { BaseAPIRepository, PaginatedResponse, ListParams, APIError } from './BaseAPIRepository';
import { BackendAPIClient } from '../services/api/BackendAPIClient';
import { logger } from '../utils/logger';
import {
  DailyStatSchema,
  ApiResponseSchema,
  PaginatedResponseSchema,
  UnifiedDashboardResponseSchema,
  UnifiedDashboardResponse,
  ActualUnifiedDashboardSchema,
  ActualUnifiedDashboardResponse,
  formatValidationErrors
} from '../utils/ValidationSchemas';
import {
  validateUUID,
  validateTimestamp,
  validatePagination,
  validateNotEmpty
} from '../utils/validators';
import { z } from 'zod';
import { DailyStat } from '../types'; 
export interface DailyStatQueryOptions {
  timezone?: string;
  includeProjections?: boolean;
  metadata?: Record<string, unknown>;
}
export interface DailyStatDateOptions {
  timezone?: string;
  forceRecompute?: boolean;
}
export interface RecomputeOptions {
  startDate?: string;
  endDate?: string;
  force?: boolean;
  timezone?: string;
}
export interface RecomputeResult {
  recomputedCount: number;
  dateRange: string;
  forced: boolean;
  processingTimeMs?: number;
  warnings?: string[];
}
export interface WeeklyStatsResult {
  weekStart: string;
  weekEnd: string;
  stats: DailyStat;
  dailyBreakdown: DailyStat[];
  comparison?: {
    previousWeek: Partial<DailyStat>;
    percentChange: Record<string, number>;
  };
}
export interface MonthlyStatsResult {
  month: string;
  stats: DailyStat;
  weeklyBreakdown: WeeklyStatsResult[];
  comparison?: {
    previousMonth: Partial<DailyStat>;
    percentChange: Record<string, number>;
  };
  trends?: {
    peakUsageDays: string[];
    averageDailyUsage: number;
    consistencyScore: number; 
  };
}
export interface YearlyStatsResult {
  year: string;
  stats: DailyStat;
  monthlyBreakdown: MonthlyStatsResult[];
  comparison?: {
    previousYear: Partial<DailyStat>;
    percentChange: Record<string, number>;
  };
  trends?: {
    seasonalPatterns: Record<string, number>; 
    peakUsageMonths: string[];
    totalSavingsYear: number;
    efficiencyScore: number; 
  };
}
export interface WeeklyStatsOptions {
  weekStart: string;
  timezone?: string;
  includeComparison?: boolean;
}
export interface MonthlyStatsOptions {
  month: string;
  timezone?: string;
  includeComparison?: boolean;
  includeWeeklyBreakdown?: boolean;
}
export interface YearlyStatsOptions {
  year: string;
  timezone?: string;
  includeComparison?: boolean;
  includeMonthlyBreakdown?: boolean;
  includeSeasonalAnalysis?: boolean;
}
export interface SavingsAnalysisResult {
  period: {
    startDate: string;
    endDate: string;
    daysIncluded: number;
  };
  totalSavings: {
    direct: number;
    waste: number;
    total: number;
    currency: string;
  };
  breakdown: {
    precisionDosing: number;
    wasteReduction: number;
    efficiencyGains: number;
    behaviorOptimization: number;
  };
  trends: {
    monthlyAverage: number;
    projectedAnnual: number;
    bestSavingsDay: { date: string; amount: number };
    consistencyScore: number; 
  };
  comparison?: {
    previousPeriod: {
      totalSavings: number;
      percentChange: number;
    };
    industryBenchmark?: {
      averageSavings: number;
      userPerformance: 'above' | 'average' | 'below';
    };
  };
}
export interface SavingsAnalysisOptions {
  startDate: string;
  endDate: string;
  timezone?: string;
  includeComparison?: boolean;
  includeBenchmark?: boolean;
  groupBy?: 'day' | 'week' | 'month';
  currency?: string;
}
export class DailyStatsRepository extends BaseAPIRepository<DailyStat> {
  protected readonly entityName = 'DailyStat';
  protected readonly baseEndpoint = '/analytics/daily';
  constructor(apiClient: BackendAPIClient) {
    super(apiClient);
    logger.debug('[DailyStatsRepository] Initialized with API-driven architecture', {
      entityName: this.entityName,
      baseEndpoint: this.baseEndpoint
    });
  }
  async create(): Promise<DailyStat> {
    throw new Error('DailyStats cannot be created directly - they are computed from consumption data. Use recomputeDailyStats() to trigger recomputation.');
  }
  async getById(): Promise<DailyStat | null> {
    throw new Error('DailyStats use date as primary key, not UUID. Use getDailyStatByDate(date) instead.');
  }
  async update(): Promise<DailyStat> {
    throw new Error('DailyStats cannot be updated directly - they are computed from consumption data. Use recomputeDailyStats() to trigger recomputation.');
  }
  async delete(): Promise<void> {
    throw new Error('DailyStats cannot be deleted - they are computed data. Stats are automatically managed based on consumption data.');
  }
  async list(params: ListParams = {}): Promise<PaginatedResponse<DailyStat>> {
    validatePagination(params.page, params.pageSize);
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const defaultFilters = {
      startDate: thirtyDaysAgo.toISOString().split('T')[0],
      endDate: today.toISOString().split('T')[0],
      ...params.filters
    };
    try {
      const queryParams = {
        ...params,
        filters: defaultFilters
      };
      const response = await this.apiGetList(this.baseEndpoint, queryParams);
      const validatedPaginatedResponse = this.validatePaginatedResponse(response, DailyStatSchema, 'list');
      const validatedResponse: PaginatedResponse<DailyStat> = {
        ...validatedPaginatedResponse,
        items: this.transformToDailyStatArray(validatedPaginatedResponse.items)
      };
      this.logSuccess('list', {
        total: validatedResponse.total,
        page: validatedResponse.page,
        pageSize: validatedResponse.pageSize,
        dateRange: `${defaultFilters.startDate} to ${defaultFilters.endDate}`,
        hasMore: validatedResponse.hasMore
      });
      return validatedResponse;
    } catch (error) {
      throw this.handleAPIError(error, 'list');
    }
  }
  async getDailyStats(
    startDate: string,
    endDate: string,
    options: DailyStatQueryOptions = {}
  ): Promise<DailyStat[]> {
    validateNotEmpty(startDate, 'startDate');
    validateNotEmpty(endDate, 'endDate');
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate)) {
      throw new Error('startDate must be in YYYY-MM-DD format');
    }
    if (!dateRegex.test(endDate)) {
      throw new Error('endDate must be in YYYY-MM-DD format');
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start > end) {
      throw new Error('startDate cannot be after endDate');
    }
    const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 365) {
      throw new Error('Date range cannot exceed 365 days');
    }
    try {
      const params = {
        startDate,
        endDate,
        timezone: options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        includeProjections: options.includeProjections || false
      };
      const response = await this.apiGet(this.baseEndpoint, params);
      const validatedStats = z.array(DailyStatSchema).parse(response);
      const dailyStatsArray = this.transformToDailyStatArray(validatedStats);
      this.logSuccess('getDailyStats', {
        startDate,
        endDate,
        timezone: params.timezone,
        count: dailyStatsArray.length,
        includeProjections: params.includeProjections,
        totalSavings: dailyStatsArray.reduce((sum, stat) => sum + parseFloat(stat.costSavedTotal), 0),
        totalHits: dailyStatsArray.reduce((sum, stat) => sum + stat.hits, 0)
      });
      return dailyStatsArray;
    } catch (error) {
      throw this.handleAPIError(error, 'getDailyStats');
    }
  }
  async getDailyStatByDate(
    date: string,
    options: DailyStatDateOptions = {}
  ): Promise<DailyStat | null> {
    validateNotEmpty(date, 'date');
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      throw new Error('date must be in YYYY-MM-DD format');
    }
    const targetDate = new Date(date);
    const today = new Date();
    today.setHours(23, 59, 59, 999); 
    if (targetDate > today) {
      throw new Error('Cannot query statistics for future dates');
    }
    try {
      const params = {
        timezone: options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
      };
      const response = await this.apiGet(`${this.baseEndpoint}/${date}`, params);
      if (!response) {
        this.logSuccess('getDailyStatByDate', {
          date,
          found: false,
          timezone: params.timezone
        });
        return null;
      }
      const validatedDailyStat = DailyStatSchema.parse(response);
      const dailyStat = this.transformToDailyStat(validatedDailyStat);
      this.logSuccess('getDailyStatByDate', {
        date,
        found: true,
        timezone: params.timezone,
        hits: dailyStat.hits,
        gramsUsed: dailyStat.gramsUsed,
        costSavedTotal: dailyStat.costSavedTotal
      });
      return dailyStat;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const httpError = error as Record<string, unknown> & { status?: number };
      if (httpError.status === 404) {
        this.logSuccess('getDailyStatByDate', {
          date,
          found: false,
          timezone: options.timezone || 'UTC'
        });
        return null;
      }
      throw this.handleAPIError(error, 'getDailyStatByDate');
    }
  }
  async recomputeDailyStats(options: RecomputeOptions = {}): Promise<RecomputeResult> {
    if (options.startDate && options.endDate) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(options.startDate)) {
        throw new Error('startDate must be in YYYY-MM-DD format');
      }
      if (!dateRegex.test(options.endDate)) {
        throw new Error('endDate must be in YYYY-MM-DD format');
      }
      const start = new Date(options.startDate);
      const end = new Date(options.endDate);
      if (start > end) {
        throw new Error('startDate cannot be after endDate');
      }
    }
    try {
      const params = {
        startDate: options.startDate,
        endDate: options.endDate,
        force: options.force || false
      };
      const response = await this.apiPost(`${this.baseEndpoint}/recompute`, params);
      const recomputeResultSchema = z.object({
        recomputedCount: z.number(),
        dateRange: z.string(),
        forced: z.boolean(),
        processingTimeMs: z.number().optional(),
        warnings: z.array(z.string()).optional()
      });
      const recomputeResult = recomputeResultSchema.parse(response);
      this.logSuccess('recomputeDailyStats', {
        startDate: options.startDate,
        endDate: options.endDate,
        forced: params.force,
        recomputedCount: recomputeResult.recomputedCount,
        dateRange: recomputeResult.dateRange,
        processingTimeMs: recomputeResult.processingTimeMs
      });
      return recomputeResult;
    } catch (error) {
      throw this.handleAPIError(error, 'recomputeDailyStats');
    }
  }
  async getWeeklyStats(options: WeeklyStatsOptions): Promise<WeeklyStatsResult> {
    validateNotEmpty(options.weekStart, 'weekStart');
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(options.weekStart)) {
      throw new Error('weekStart must be in YYYY-MM-DD format');
    }
    const weekStartDate = new Date(options.weekStart);
    if (weekStartDate.getDay() !== 1) { 
      logger.warn('weekStart should be a Monday for accurate weekly aggregation', {
        weekStart: options.weekStart,
        dayOfWeek: weekStartDate.getDay()
      });
    }
    try {
      const weekStartDateObj = new Date(options.weekStart);
      const weekEndDateObj = new Date(weekStartDateObj);
      weekEndDateObj.setDate(weekStartDateObj.getDate() + 6);
      const weekEnd = weekEndDateObj.toISOString().split('T')[0]!;
      const dailyStats = await this.getDailyStats(options.weekStart, weekEnd, {
        timezone: options.timezone,
        includeProjections: false
      });
      const weeklyTotals = dailyStats.reduce(
        (totals, dayStat) => ({
          hits: totals.hits + dayStat.hits,
          gramsUsed: totals.gramsUsed + parseFloat(String(dayStat.gramsUsed || '0')),
          costSpentActual: totals.costSpentActual + parseFloat(String(dayStat.costSpentActual || '0')),
          costSpentBaseline: totals.costSpentBaseline + parseFloat(String(dayStat.costSpentBaseline || '0')),
          costSavedDirect: totals.costSavedDirect + parseFloat(String(dayStat.costSavedDirect || '0')),
          costSavedWaste: totals.costSavedWaste + parseFloat(String(dayStat.costSavedWaste || '0')),
          costSavedTotal: totals.costSavedTotal + parseFloat(String(dayStat.costSavedTotal || '0')),
          userId: totals.userId || dayStat.userId, 
        }),
        {
          hits: 0,
          gramsUsed: 0,
          costSpentActual: 0,
          costSpentBaseline: 0,
          costSavedDirect: 0,
          costSavedWaste: 0,
          costSavedTotal: 0,
          userId: '' as string,
        }
      );
      const aggregatedStats: DailyStat = {
        date: options.weekStart, 
        userId: weeklyTotals.userId,
        hits: weeklyTotals.hits,
        gramsUsed: weeklyTotals.gramsUsed.toFixed(3), 
        costSpentActual: weeklyTotals.costSpentActual.toFixed(2), 
        costSpentBaseline: weeklyTotals.costSpentBaseline.toFixed(2),
        costSavedDirect: weeklyTotals.costSavedDirect.toFixed(2),
        costSavedWaste: weeklyTotals.costSavedWaste.toFixed(2),
        costSavedTotal: weeklyTotals.costSavedTotal.toFixed(2),
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const result: WeeklyStatsResult = {
        weekStart: options.weekStart,
        weekEnd,
        stats: aggregatedStats,
        dailyBreakdown: dailyStats,
        comparison: undefined, 
      };
      this.logSuccess('getWeeklyStats', {
        weekStart: options.weekStart,
        weekEnd,
        timezone: options.timezone || 'UTC',
        totalHits: result.stats.hits,
        totalSavings: result.stats.costSavedTotal,
        daysWithData: result.dailyBreakdown.filter(day => day.hits > 0).length,
        includeComparison: options.includeComparison || false
      });
      return result;
    } catch (error) {
      throw this.handleAPIError(error, 'getWeeklyStats');
    }
  }
  async getMonthlyStats(options: MonthlyStatsOptions): Promise<MonthlyStatsResult> {
    validateNotEmpty(options.month, 'month');
    const monthRegex = /^\d{4}-\d{2}$/;
    if (!monthRegex.test(options.month)) {
      throw new Error('month must be in YYYY-MM format');
    }
    const [year, month] = options.month.split('-').map(Number);
    const targetMonth = new Date(year!, month! - 1, 1);
    const currentMonth = new Date();
    currentMonth.setDate(1); 
    if (targetMonth > currentMonth) {
      throw new Error('Cannot query statistics for future months');
    }
    try {
      const params = {
        month: options.month,
        timezone: options.timezone || 'UTC',
        includeComparison: options.includeComparison || false,
        includeWeeklyBreakdown: options.includeWeeklyBreakdown || true
      };
      const response = await this.apiGet(`${this.baseEndpoint}/monthly`, params);
      const monthlyStatsSchema = z.object({
        month: z.string(),
        stats: DailyStatSchema,
        weeklyBreakdown: z.array(z.object({
          weekStart: z.string(),
          weekEnd: z.string(),
          stats: DailyStatSchema,
          dailyBreakdown: z.array(DailyStatSchema),
          comparison: z.object({
            previousWeek: DailyStatSchema.partial(),
            percentChange: z.record(z.number())
          }).optional()
        })).optional(),
        comparison: z.object({
          previousMonth: DailyStatSchema.partial(),
          percentChange: z.record(z.number())
        }).optional(),
        trends: z.object({
          peakUsageDays: z.array(z.string()),
          averageDailyUsage: z.number(),
          consistencyScore: z.number()
        }).optional()
      });
      const monthlyStats = monthlyStatsSchema.parse(response);
      const result: MonthlyStatsResult = {
        month: monthlyStats.month,
        stats: this.transformToDailyStat(monthlyStats.stats),
        weeklyBreakdown: monthlyStats.weeklyBreakdown?.map(week => ({
          weekStart: week.weekStart,
          weekEnd: week.weekEnd,
          stats: this.transformToDailyStat(week.stats),
          dailyBreakdown: this.transformToDailyStatArray(week.dailyBreakdown),
          comparison: week.comparison ? {
            previousWeek: this.transformPartialDailyStat(week.comparison.previousWeek),
            percentChange: week.comparison.percentChange
          } : undefined
        })) || [],
        comparison: monthlyStats.comparison ? {
          previousMonth: this.transformPartialDailyStat(monthlyStats.comparison.previousMonth),
          percentChange: monthlyStats.comparison.percentChange
        } : undefined,
        trends: monthlyStats.trends
      };
      this.logSuccess('getMonthlyStats', {
        month: options.month,
        timezone: params.timezone,
        totalHits: result.stats.hits,
        totalSavings: result.stats.costSavedTotal,
        weeksIncluded: result.weeklyBreakdown.length,
        averageDailyUsage: result.trends?.averageDailyUsage,
        consistencyScore: result.trends?.consistencyScore,
        includeComparison: params.includeComparison
      });
      return result;
    } catch (error) {
      throw this.handleAPIError(error, 'getMonthlyStats');
    }
  }
  async getYearlyStats(options: YearlyStatsOptions): Promise<YearlyStatsResult> {
    validateNotEmpty(options.year, 'year');
    const yearRegex = /^\d{4}$/;
    if (!yearRegex.test(options.year)) {
      throw new Error('year must be in YYYY format');
    }
    const year = parseInt(options.year, 10);
    const currentYear = new Date().getFullYear();
    if (year > currentYear) {
      throw new Error('Cannot query statistics for future years');
    }
    if (year < 2020) {
      throw new Error('Year must be 2020 or later');
    }
    try {
      const params = {
        year: options.year,
        timezone: options.timezone || 'UTC',
        includeComparison: options.includeComparison || false,
        includeMonthlyBreakdown: options.includeMonthlyBreakdown || true,
        includeSeasonalAnalysis: options.includeSeasonalAnalysis || true
      };
      const response = await this.apiGet(`${this.baseEndpoint}/yearly`, params);
      const yearlyStatsSchema = z.object({
        year: z.string(),
        stats: DailyStatSchema,
        monthlyBreakdown: z.array(z.object({
          month: z.string(),
          stats: DailyStatSchema,
          weeklyBreakdown: z.array(z.object({
            weekStart: z.string(),
            weekEnd: z.string(),
            stats: DailyStatSchema,
            dailyBreakdown: z.array(DailyStatSchema),
            comparison: z.object({
              previousWeek: DailyStatSchema.partial(),
              percentChange: z.record(z.number())
            }).optional()
          })).optional(),
          comparison: z.object({
            previousMonth: DailyStatSchema.partial(),
            percentChange: z.record(z.number())
          }).optional(),
          trends: z.object({
            peakUsageDays: z.array(z.string()),
            averageDailyUsage: z.number(),
            consistencyScore: z.number()
          }).optional()
        })).optional(),
        comparison: z.object({
          previousYear: DailyStatSchema.partial(),
          percentChange: z.record(z.number())
        }).optional(),
        trends: z.object({
          seasonalPatterns: z.record(z.number()),
          peakUsageMonths: z.array(z.string()),
          totalSavingsYear: z.number(),
          efficiencyScore: z.number()
        }).optional()
      });
      const yearlyStats = yearlyStatsSchema.parse(response);
      const result: YearlyStatsResult = {
        year: yearlyStats.year,
        stats: this.transformToDailyStat(yearlyStats.stats),
        monthlyBreakdown: yearlyStats.monthlyBreakdown?.map(month => ({
          month: month.month,
          stats: this.transformToDailyStat(month.stats),
          weeklyBreakdown: month.weeklyBreakdown?.map(week => ({
            weekStart: week.weekStart,
            weekEnd: week.weekEnd,
            stats: this.transformToDailyStat(week.stats),
            dailyBreakdown: this.transformToDailyStatArray(week.dailyBreakdown),
            comparison: week.comparison ? {
              previousWeek: this.transformPartialDailyStat(week.comparison.previousWeek),
              percentChange: week.comparison.percentChange
            } : undefined
          })) || [],
          comparison: month.comparison ? {
            previousMonth: this.transformPartialDailyStat(month.comparison.previousMonth),
            percentChange: month.comparison.percentChange
          } : undefined,
          trends: month.trends
        })) || [],
        comparison: yearlyStats.comparison ? {
          previousYear: this.transformPartialDailyStat(yearlyStats.comparison.previousYear),
          percentChange: yearlyStats.comparison.percentChange
        } : undefined,
        trends: yearlyStats.trends
      };
      this.logSuccess('getYearlyStats', {
        year: options.year,
        timezone: params.timezone,
        totalHits: result.stats.hits,
        totalSavings: result.stats.costSavedTotal,
        monthsIncluded: result.monthlyBreakdown.length,
        efficiencyScore: result.trends?.efficiencyScore,
        includeComparison: params.includeComparison,
        includeSeasonalAnalysis: params.includeSeasonalAnalysis
      });
      return result;
    } catch (error) {
      throw this.handleAPIError(error, 'getYearlyStats');
    }
  }
  async getSavingsAnalysis(options: SavingsAnalysisOptions): Promise<SavingsAnalysisResult> {
    validateNotEmpty(options.startDate, 'startDate');
    validateNotEmpty(options.endDate, 'endDate');
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(options.startDate)) {
      throw new Error('startDate must be in YYYY-MM-DD format');
    }
    if (!dateRegex.test(options.endDate)) {
      throw new Error('endDate must be in YYYY-MM-DD format');
    }
    const start = new Date(options.startDate);
    const end = new Date(options.endDate);
    if (start > end) {
      throw new Error('startDate cannot be after endDate');
    }
    const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 730) {
      throw new Error('Analysis period cannot exceed 2 years (730 days)');
    }
    try {
      const params = {
        startDate: options.startDate,
        endDate: options.endDate,
        timezone: options.timezone || 'UTC',
        includeComparison: options.includeComparison || false,
        includeBenchmark: options.includeBenchmark || false,
        groupBy: options.groupBy || 'day',
        currency: options.currency || 'USD'
      };
      const response = await this.apiGet(`${this.baseEndpoint}/savings`, params);
      const savingsAnalysisSchema = z.object({
        period: z.object({
          startDate: z.string(),
          endDate: z.string(),
          daysIncluded: z.number()
        }),
        totalSavings: z.object({
          direct: z.number(),
          waste: z.number(),
          total: z.number(),
          currency: z.string()
        }),
        breakdown: z.object({
          precisionDosing: z.number(),
          wasteReduction: z.number(),
          efficiencyGains: z.number(),
          behaviorOptimization: z.number()
        }),
        trends: z.object({
          monthlyAverage: z.number(),
          projectedAnnual: z.number(),
          bestSavingsDay: z.object({
            date: z.string(),
            amount: z.number()
          }),
          consistencyScore: z.number()
        }),
        comparison: z.object({
          previousPeriod: z.object({
            totalSavings: z.number(),
            percentChange: z.number()
          }),
          industryBenchmark: z.object({
            averageSavings: z.number(),
            userPerformance: z.enum(['above', 'average', 'below'])
          }).optional()
        }).optional()
      });
      const savingsAnalysis = savingsAnalysisSchema.parse(response);
      this.logSuccess('getSavingsAnalysis', {
        startDate: options.startDate,
        endDate: options.endDate,
        daysIncluded: savingsAnalysis.period.daysIncluded,
        totalSavings: savingsAnalysis.totalSavings.total,
        currency: savingsAnalysis.totalSavings.currency,
        consistencyScore: savingsAnalysis.trends.consistencyScore,
        projectedAnnual: savingsAnalysis.trends.projectedAnnual,
        includeComparison: params.includeComparison,
        includeBenchmark: params.includeBenchmark
      });
      return savingsAnalysis;
    } catch (error) {
      throw this.handleAPIError(error, 'getSavingsAnalysis');
    }
  }
  async getDailyStatistics(startDate: string, endDate: string, options: DailyStatQueryOptions = {}): Promise<DailyStat[]> {
    return this.getDailyStats(startDate, endDate, options);
  }
  async getStatsByDate(date: string, options: DailyStatDateOptions = {}): Promise<DailyStat | null> {
    return this.getDailyStatByDate(date, options);
  }
  async refreshDailyStats(options: RecomputeOptions = {}): Promise<RecomputeResult> {
    return this.recomputeDailyStats(options);
  }
  async getWeeklyAggregation(weekStart: string, timezone?: string): Promise<WeeklyStatsResult> {
    return this.getWeeklyStats({ weekStart, timezone });
  }
  async getMonthlyAggregation(month: string, timezone?: string): Promise<MonthlyStatsResult> {
    return this.getMonthlyStats({ month, timezone });
  }
  async getDailyStatsRange(
    startDate: string,
    endDate: string,
    timezone?: string,
    includeProjections?: boolean
  ): Promise<DailyStat[]> {
    logger.warn('getDailyStatsRange is deprecated, use getDailyStats instead');
    return this.getDailyStats(startDate, endDate, { timezone, includeProjections });
  }
  async getLastNDaysStats(
    days: number,
    timezone?: string,
    includeProjections?: boolean
  ): Promise<DailyStat[]> {
    logger.warn('getLastNDaysStats is deprecated, use getDailyStats with calculated date range instead');
    const endDate = new Date().toISOString().split('T')[0]!;
    const startDate = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]!;
    return this.getDailyStats(startDate, endDate, { timezone, includeProjections });
  }
  async getTodaysStat(timezone?: string): Promise<DailyStat | null> {
    logger.warn('getTodaysStat is deprecated, use getDailyStatByDate with today\'s date instead');
    const today = new Date().toISOString().split('T')[0]!;
    return this.getDailyStatByDate(today, { timezone });
  }
  async getCumulativeSavingsToDate(endDate?: string, timezone?: string): Promise<number> {
    logger.warn('getCumulativeSavingsToDate is deprecated, use getSavingsAnalysis instead');
    const actualEndDate = endDate || new Date().toISOString().split('T')[0]!;
    const startDate = '2020-01-01'; 
    try {
      const dailyStats = await this.getDailyStats(startDate, actualEndDate, { timezone });
      return dailyStats.reduce((total, stat) => total + parseFloat(stat.costSavedTotal), 0);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to calculate cumulative savings', {
        endDate: actualEndDate,
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack
        }
      });
      return 0;
    }
  }
  async getDailyStatsForDateRange(
    userId: string,
    startDate: string,
    endDate: string,
    timezone?: string
  ): Promise<{ success: boolean; data: DailyStat[] | null; error?: string }> {
    logger.warn('getDailyStatsForDateRange is deprecated, use getDailyStats instead');
    try {
      const dailyStats = await this.getDailyStats(startDate, endDate, { timezone });
      return {
        success: true,
        data: dailyStats
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to get daily stats for date range', {
        userId,
        startDate,
        endDate,
        timezone,
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack
        }
      });
      return {
        success: false,
        data: null,
        error: err.message
      };
    }
  }
  async getHourlyBreakdown(
    startDate?: string,
    endDate?: string
  ): Promise<{
    hourlyDistribution: number[];
    dailyDistribution: number[];
    peakHour: number;
    peakDay: number;
    timeOfDayBreakdown: {
      morning: number;
      afternoon: number;
      evening: number;
      night: number;
    };
  }> {
    try {
      const params: Record<string, string> = {};
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      const response = await this.apiGet('/analytics/hourly', params);
      if (!response || typeof response !== 'object') {
        throw new Error('Invalid hourly breakdown response from server');
      }
      const data = response as {
        hourlyDistribution?: number[];
        dailyDistribution?: number[];
        peakHour?: number;
        peakDay?: number;
        timeOfDayBreakdown?: {
          morning?: number;
          afternoon?: number;
          evening?: number;
          night?: number;
        };
      };
      if (!Array.isArray(data.hourlyDistribution) || data.hourlyDistribution.length !== 24) {
        throw new Error('Invalid hourlyDistribution in response');
      }
      if (!Array.isArray(data.dailyDistribution) || data.dailyDistribution.length !== 7) {
        throw new Error('Invalid dailyDistribution in response');
      }
      if (typeof data.peakHour !== 'number' || typeof data.peakDay !== 'number') {
        throw new Error('Invalid peak hour/day in response');
      }
      if (!data.timeOfDayBreakdown) {
        throw new Error('Missing timeOfDayBreakdown in response');
      }
      logger.info('Hourly breakdown retrieved successfully', {
        context: 'DailyStatsRepository.getHourlyBreakdown',
        peakHour: data.peakHour,
        peakDay: data.peakDay,
      });
      return {
        hourlyDistribution: data.hourlyDistribution,
        dailyDistribution: data.dailyDistribution,
        peakHour: data.peakHour,
        peakDay: data.peakDay,
        timeOfDayBreakdown: {
          morning: data.timeOfDayBreakdown.morning || 0,
          afternoon: data.timeOfDayBreakdown.afternoon || 0,
          evening: data.timeOfDayBreakdown.evening || 0,
          night: data.timeOfDayBreakdown.night || 0,
        },
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to get hourly breakdown', {
        context: 'DailyStatsRepository.getHourlyBreakdown',
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack
        }
      });
      throw err;
    }
  }
  async getStrainEffectiveness(
    startDate?: string,
    endDate?: string
  ): Promise<{
    variants: Array<{
      strainId: string;
      strainName: string;
      usageCount: number;
      averageRating: number;
      averageIntensity: number;
      effectivenessScore: number;
      effects: Record<string, number>;
      timeOfDayPreference: Record<string, number>;
      toleranceIndicator: 'low' | 'medium' | 'high';
      recommendations: string[];
    }>;
    insights: {
      mostEffectiveStrain: string;
      mostConsistentStrain: string;
      recommendedForTimes: Record<string, string>;
      toleranceWarnings: string[];
    };
  }> {
    try {
      const params: Record<string, string> = {};
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      const response = await this.apiGet('/analytics/variant-effectiveness', params);
      if (!response || typeof response !== 'object') {
        throw new Error('Invalid variant effectiveness response from server');
      }
      const data = response as {
        variants?: unknown[];
        insights?: {
          mostEffectiveStrain?: string;
          mostConsistentStrain?: string;
          recommendedForTimes?: Record<string, string>;
          toleranceWarnings?: string[];
        };
      };
      if (!Array.isArray(data.variants)) {
        throw new Error('Invalid variants array in response');
      }
      if (!data.insights || typeof data.insights !== 'object') {
        throw new Error('Missing insights in response');
      }
      logger.info('Variant effectiveness analysis retrieved successfully', {
        context: 'DailyStatsRepository.getStrainEffectiveness',
        strainsCount: data.variants.length,
        mostEffective: data.insights.mostEffectiveStrain,
      });
      return data as {
        variants: Array<{
          strainId: string;
          strainName: string;
          usageCount: number;
          averageRating: number;
          averageIntensity: number;
          effectivenessScore: number;
          effects: Record<string, number>;
          timeOfDayPreference: Record<string, number>;
          toleranceIndicator: 'low' | 'medium' | 'high';
          recommendations: string[];
        }>;
        insights: {
          mostEffectiveStrain: string;
          mostConsistentStrain: string;
          recommendedForTimes: Record<string, string>;
          toleranceWarnings: string[];
        };
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to get variant effectiveness', {
        context: 'DailyStatsRepository.getStrainEffectiveness',
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack
        }
      });
      throw err;
    }
  }
  async getUnifiedDashboard(options: {
    timezone?: string;
    includeComparison?: boolean;
    date?: string;
  } = {}): Promise<ActualUnifiedDashboardResponse> {
    try {
      const params: Record<string, string> = {};
      params.timezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (options.includeComparison !== undefined) params.includeComparison = String(options.includeComparison);
      if (options.date) params.date = options.date;
      const response = await this.apiGet('/analytics/dashboard-unified', params);
      const validated = ActualUnifiedDashboardSchema.parse(response);
      this.logSuccess('getUnifiedDashboard', {
        timezone: validated.metadata.timezone,
        todayDate: validated.daily.date,
        todayHits: validated.daily.stats?.hits ?? 0,
        todaySavings: validated.daily.stats?.costSavedTotal ?? '0.00',
        weeklyHits: validated.weekly.stats?.hits ?? 0,
        weekStart: validated.weekly.weekStart,
        weekEnd: validated.weekly.weekEnd,
        weekDays: validated.weekly.dailyBreakdown.length,
        monthlyHits: validated.monthly.stats?.hits ?? 0,
        yearlyHits: validated.yearly.stats.hits,
        yearlyMonths: validated.yearly.monthlyBreakdown.length,
        strainsAnalyzed: validated.strainEffectiveness.variants.length,
        peakHour: validated.daily.hourlyBreakdown.peakHour,
        correlationId: validated.metadata.correlationId
      });
      return validated;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to get unified dashboard', {
        context: 'DailyStatsRepository.getUnifiedDashboard',
        timezone: options.timezone,
        date: options.date,
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack
        }
      });
      throw this.handleAPIError(error, 'getUnifiedDashboard');
    }
  }
  async getUnifiedDashboardLegacy(options: {
    timezone?: string;
    includeComparison?: boolean;
    date?: string;
  } = {}): Promise<UnifiedDashboardResponse> {
    logger.warn('[DailyStatsRepository] getUnifiedDashboardLegacy is deprecated, use getUnifiedDashboard instead');
    try {
      const params: Record<string, string> = {};
      if (options.timezone) params.timezone = options.timezone;
      if (options.includeComparison !== undefined) params.includeComparison = String(options.includeComparison);
      if (options.date) params.date = options.date;
      const response = await this.apiGet('/analytics/dashboard-unified', params);
      const validated = UnifiedDashboardResponseSchema.parse(response);
      return validated;
    } catch (error: unknown) {
      throw this.handleAPIError(error, 'getUnifiedDashboardLegacy');
    }
  }
  private transformToDailyStat(validatedData: Record<string, unknown>): DailyStat {
    return {
      date: validatedData.date as string,
      userId: validatedData.userId as string,
      gramsUsed: (validatedData.gramsUsed as string | undefined) || '0', 
      hits: (validatedData.hits as number | undefined) || 0,
      costSpentActual: (validatedData.costSpentActual as string | undefined) || '0.00', 
      costSpentBaseline: (validatedData.costSpentBaseline as string | undefined) || '0.00', 
      costSavedDirect: (validatedData.costSavedDirect as string | undefined) || '0.00', 
      costSavedWaste: (validatedData.costSavedWaste as string | undefined) || '0.00', 
      costSavedTotal: (validatedData.costSavedTotal as string | undefined) || '0.00', 
      version: validatedData.version as number | undefined,
      createdAt: validatedData.createdAt as string,
      updatedAt: validatedData.updatedAt as string
    };
  }
  private transformToDailyStatArray(validatedStats: Array<Record<string, unknown>>): DailyStat[] {
    return validatedStats.map(item => this.transformToDailyStat(item));
  }
  private transformPartialDailyStat(validatedData: Record<string, unknown> | null | undefined): Partial<DailyStat> {
    if (!validatedData) return {};
    const result: Partial<DailyStat> = {};
    if (validatedData.userId !== undefined) result.userId = validatedData.userId as string;
    if (validatedData.date !== undefined) result.date = validatedData.date as string;
    if (validatedData.gramsUsed !== undefined) {
      result.gramsUsed = (validatedData.gramsUsed as string | undefined) || '0';
    }
    if (validatedData.hits !== undefined) result.hits = (validatedData.hits as number | undefined) || 0;
    if (validatedData.costSpentActual !== undefined) {
      result.costSpentActual = (validatedData.costSpentActual as string | undefined) || '0.00';
    }
    if (validatedData.costSpentBaseline !== undefined) {
      result.costSpentBaseline = (validatedData.costSpentBaseline as string | undefined) || '0.00';
    }
    if (validatedData.costSavedDirect !== undefined) {
      result.costSavedDirect = (validatedData.costSavedDirect as string | undefined) || '0.00';
    }
    if (validatedData.costSavedWaste !== undefined) {
      result.costSavedWaste = (validatedData.costSavedWaste as string | undefined) || '0.00';
    }
    if (validatedData.costSavedTotal !== undefined) {
      result.costSavedTotal = (validatedData.costSavedTotal as string | undefined) || '0.00';
    }
    if (validatedData.version !== undefined) result.version = validatedData.version as number;
    if (validatedData.createdAt !== undefined) result.createdAt = validatedData.createdAt as string;
    if (validatedData.updatedAt !== undefined) result.updatedAt = validatedData.updatedAt as string;
    return result;
  }
}
export default DailyStatsRepository;