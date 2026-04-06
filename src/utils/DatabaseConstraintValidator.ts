import { AISummary, SummaryType } from '../types';
import * as Logger from '../services/ai/utils/logging';
export class DatabaseConstraintValidator {
  private static readonly MODULE_NAME = 'DatabaseConstraintValidator';
  private static readonly VALID_SUMMARY_TYPES: SummaryType[] = [
    'journal_analysis',
    'recommendation', 
    'chat_summary'
  ];
  private static readonly MAX_FIELD_LENGTHS = {
    id: 255,
    user_id: 255,
    summary_type: 50,
    source_ids: 1000, 
    summary_content: 50000, 
    model_used: 100
  };
  public static validateAISummary(summary: AISummary): ValidationResult {
    const errors: string[] = [];
    try {
      if (!summary.id || summary.id.trim() === '') {
        errors.push('ID is required and cannot be empty');
      }
      if (!summary.user_id || summary.user_id.trim() === '') {
        errors.push('User ID is required and cannot be empty');
      }
      if (!summary.summary_type || summary.summary_type.trim() === '') {
        errors.push('Summary type is required and cannot be empty');
      }
      if (!summary.summary_content || summary.summary_content.trim() === '') {
        errors.push('Summary content is required and cannot be empty');
      }
      if (summary.summary_type && !this.VALID_SUMMARY_TYPES.includes(summary.summary_type)) {
        errors.push(
          `Invalid summary_type '${summary.summary_type}'. Must be one of: ${this.VALID_SUMMARY_TYPES.join(', ')}`
        );
      }
      if (summary.id && summary.id.length > this.MAX_FIELD_LENGTHS.id) {
        errors.push(`ID exceeds maximum length of ${this.MAX_FIELD_LENGTHS.id} characters`);
      }
      if (summary.user_id && summary.user_id.length > this.MAX_FIELD_LENGTHS.user_id) {
        errors.push(`User ID exceeds maximum length of ${this.MAX_FIELD_LENGTHS.user_id} characters`);
      }
      if (summary.summary_type && summary.summary_type.length > this.MAX_FIELD_LENGTHS.summary_type) {
        errors.push(`Summary type exceeds maximum length of ${this.MAX_FIELD_LENGTHS.summary_type} characters`);
      }
      if (summary.source_ids && summary.source_ids.length > this.MAX_FIELD_LENGTHS.source_ids) {
        errors.push(`Source IDs exceed maximum length of ${this.MAX_FIELD_LENGTHS.source_ids} characters`);
      }
      if (summary.summary_content && summary.summary_content.length > this.MAX_FIELD_LENGTHS.summary_content) {
        errors.push(`Summary content exceeds maximum length of ${this.MAX_FIELD_LENGTHS.summary_content} characters`);
      }
      if (summary.model_used && summary.model_used.length > this.MAX_FIELD_LENGTHS.model_used) {
        errors.push(`Model used exceeds maximum length of ${this.MAX_FIELD_LENGTHS.model_used} characters`);
      }
      if (summary.source_ids) {
        try {
          JSON.parse(summary.source_ids);
        } catch (jsonError) {
          errors.push('Source IDs must be valid JSON format');
        }
      }
      if (summary.generated_at) {
        const timestamp = new Date(summary.generated_at);
        if (isNaN(timestamp.getTime())) {
          errors.push('Generated at timestamp must be a valid ISO date string');
        }
      }
      const isValid = errors.length === 0;
      if (!isValid) {
        Logger.warn(this.MODULE_NAME, `Validation failed for summary ${summary.id}: ${errors.join(', ')}`);
      }
      return {
        isValid,
        errors,
        summary: isValid ? summary : null
      };
    } catch (error) {
      Logger.error(this.MODULE_NAME, `Unexpected error during validation: ${error}`);
      return {
        isValid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`],
        summary: null
      };
    }
  }
  public static sanitizeAISummary(summary: AISummary): AISummary {
    try {
      const sanitized: AISummary = { ...summary };
      if (!sanitized.id || sanitized.id.trim() === '') {
        sanitized.id = `summary_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }
      if (!sanitized.user_id || sanitized.user_id.trim() === '') {
        Logger.warn(this.MODULE_NAME, 'Missing user_id in summary, cannot sanitize');
        throw new Error('User ID is required and cannot be sanitized');
      }
      if (!sanitized.summary_type || !this.VALID_SUMMARY_TYPES.includes(sanitized.summary_type)) {
        Logger.warn(this.MODULE_NAME, `Invalid summary_type '${sanitized.summary_type}', defaulting to 'journal_analysis'`);
        sanitized.summary_type = 'journal_analysis';
      }
      if (!sanitized.summary_content || sanitized.summary_content.trim() === '') {
        sanitized.summary_content = 'No content available';
      }
      if (sanitized.id.length > this.MAX_FIELD_LENGTHS.id) {
        sanitized.id = sanitized.id.substring(0, this.MAX_FIELD_LENGTHS.id);
      }
      if (sanitized.user_id.length > this.MAX_FIELD_LENGTHS.user_id) {
        sanitized.user_id = sanitized.user_id.substring(0, this.MAX_FIELD_LENGTHS.user_id);
      }
      if (sanitized.summary_type.length > this.MAX_FIELD_LENGTHS.summary_type) {
        sanitized.summary_type = sanitized.summary_type.substring(0, this.MAX_FIELD_LENGTHS.summary_type) as SummaryType;
      }
      if (sanitized.source_ids && sanitized.source_ids.length > this.MAX_FIELD_LENGTHS.source_ids) {
        sanitized.source_ids = sanitized.source_ids.substring(0, this.MAX_FIELD_LENGTHS.source_ids);
      }
      if (sanitized.summary_content.length > this.MAX_FIELD_LENGTHS.summary_content) {
        sanitized.summary_content = sanitized.summary_content.substring(0, this.MAX_FIELD_LENGTHS.summary_content - 3) + '...';
      }
      if (sanitized.model_used && sanitized.model_used.length > this.MAX_FIELD_LENGTHS.model_used) {
        sanitized.model_used = sanitized.model_used.substring(0, this.MAX_FIELD_LENGTHS.model_used);
      }
      if (!sanitized.generated_at) {
        sanitized.generated_at = new Date().toISOString();
      } else {
        const timestamp = new Date(sanitized.generated_at);
        if (isNaN(timestamp.getTime())) {
          sanitized.generated_at = new Date().toISOString();
        }
      }
      if (sanitized.source_ids) {
        try {
          JSON.parse(sanitized.source_ids);
        } catch (jsonError) {
          Logger.warn(this.MODULE_NAME, `Invalid JSON in source_ids, clearing field: ${jsonError}`);
          sanitized.source_ids = null;
        }
      }
      Logger.info(this.MODULE_NAME, `Successfully sanitized summary ${sanitized.id}`);
      return sanitized;
    } catch (error) {
      Logger.error(this.MODULE_NAME, `Failed to sanitize summary: ${error}`);
      throw error;
    }
  }
  public static mapLegacySummaryType(legacyType: string): SummaryType {
    const typeMapping: Record<string, SummaryType> = {
      'weekly_usage_report': 'journal_analysis',
      'monthly_usage_report': 'journal_analysis', 
      'strain_effectiveness': 'recommendation',
      'recommendation_context': 'recommendation',
      'journal_analysis': 'journal_analysis',
      'recommendation': 'recommendation',
      'chat_summary': 'chat_summary'
    };
    const mappedType = typeMapping[legacyType];
    if (!mappedType) {
      Logger.warn(this.MODULE_NAME, `Unknown legacy type '${legacyType}', defaulting to 'journal_analysis'`);
      return 'journal_analysis';
    }
    return mappedType;
  }
  public static createSourceIdsWithOriginalType(originalType: string, sourceIds?: Record<string, unknown> | string[] | null): string {
    try {
      const sourceData: Record<string, unknown> = {
        originalType,
        timestamp: new Date().toISOString()
      };
      if (sourceIds) {
        sourceData.sourceIds = sourceIds;
      }
      return JSON.stringify(sourceData);
    } catch (error) {
      Logger.error(this.MODULE_NAME, `Failed to create source_ids JSON: ${error}`);
      return JSON.stringify({ originalType, timestamp: new Date().toISOString() });
    }
  }
}
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  summary: AISummary | null;
}
export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 5000,
  backoffMultiplier: 2
};