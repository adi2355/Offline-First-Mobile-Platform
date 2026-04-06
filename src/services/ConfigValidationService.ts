import Constants from 'expo-constants';
export interface FrontendConfigValidationResult {
  isValid: boolean;
  errors: FrontendConfigError[];
  warnings: FrontendConfigWarning[];
  securityScore: number;
  recommendations: string[];
}
export interface FrontendConfigError {
  field: string;
  message: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
}
export interface FrontendConfigWarning {
  field: string;
  message: string;
  recommendation: string;
}
export interface FrontendConfigAudit {
  timestamp: Date;
  environment: string;
  validationResult: FrontendConfigValidationResult;
  exposedVariables: ExposedVariableAudit[];
  apiConfiguration: ApiConfigurationAudit;
}
export interface ExposedVariableAudit {
  name: string;
  value: string;
  isExposed: boolean;
  exposureRisk: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recommendation?: string;
}
export interface ApiConfigurationAudit {
  baseUrl: string;
  isSecure: boolean;
  usesHttps: boolean;
  recommendations: string[];
}
const SECURITY_PATTERNS = {
  API_KEY: /^(sk-|pk_|api_key_|key_)/i,
  SECRET: /^(secret|password|pwd|pass)/i,
  TOKEN: /^(token|jwt|auth)/i,
  PRIVATE_KEY: /^(private_key|priv_key)/i,
};
export class ConfigValidationService {
  private static instance: ConfigValidationService;
  public static getInstance(): ConfigValidationService {
    if (!ConfigValidationService.instance) {
      ConfigValidationService.instance = new ConfigValidationService();
    }
    return ConfigValidationService.instance;
  }
  public async validateConfiguration(): Promise<FrontendConfigValidationResult> {
    const errors: FrontendConfigError[] = [];
    const warnings: FrontendConfigWarning[] = [];
    const recommendations: string[] = [];
    try {
      const requiredValidation = this.validateRequiredConfiguration();
      errors.push(...requiredValidation.errors);
      warnings.push(...requiredValidation.warnings);
      const exposureValidation = this.validateExposedVariables();
      errors.push(...exposureValidation.errors);
      warnings.push(...exposureValidation.warnings);
      const apiValidation = this.validateApiConfiguration();
      errors.push(...apiValidation.errors);
      warnings.push(...apiValidation.warnings);
      const securityScore = this.calculateSecurityScore(errors, warnings);
      recommendations.push(...this.generateRecommendations(errors, warnings));
      return {
        isValid: errors.filter(e => e.severity === 'CRITICAL' || e.severity === 'HIGH').length === 0,
        errors,
        warnings,
        securityScore,
        recommendations,
      };
    } catch (error) {
      errors.push({
        field: 'configuration',
        message: `Configuration validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        severity: 'CRITICAL',
      });
      return {
        isValid: false,
        errors,
        warnings,
        securityScore: 0,
        recommendations: ['Fix configuration validation errors before proceeding'],
      };
    }
  }
  private validateRequiredConfiguration(): { errors: FrontendConfigError[]; warnings: FrontendConfigWarning[] } {
    const errors: FrontendConfigError[] = [];
    const warnings: FrontendConfigWarning[] = [];
    const config = Constants.expoConfig;
    const extra = config?.extra;
    if (!extra?.API_BASE_URL) {
      errors.push({
        field: 'API_BASE_URL',
        message: 'API base URL is required for backend communication',
        severity: 'CRITICAL',
      });
    } else {
      if (!extra.API_BASE_URL.startsWith('https://') && !extra.API_BASE_URL.includes('localhost')) {
        warnings.push({
          field: 'API_BASE_URL',
          message: 'API base URL should use HTTPS in production',
          recommendation: 'Use HTTPS for production API endpoints',
        });
      }
      if (extra.API_BASE_URL.includes('localhost') && process.env.NODE_ENV === 'production') {
        errors.push({
          field: 'API_BASE_URL',
          message: 'Localhost API URL should not be used in production',
          severity: 'HIGH',
        });
      }
    }
    return { errors, warnings };
  }
  private validateExposedVariables(): { errors: FrontendConfigError[]; warnings: FrontendConfigWarning[] } {
    const errors: FrontendConfigError[] = [];
    const warnings: FrontendConfigWarning[] = [];
    const config = Constants.expoConfig;
    const extra = config?.extra;
    if (extra) {
      Object.entries(extra).forEach(([key, value]) => {
        if (typeof value === 'string') {
          Object.entries(SECURITY_PATTERNS).forEach(([patternName, pattern]) => {
            if (pattern.test(key)) {
              errors.push({
                field: key,
                message: `Configuration key ${key} appears to contain sensitive data (${patternName})`,
                severity: 'CRITICAL',
              });
            }
            if (pattern.test(value)) {
              errors.push({
                field: key,
                message: `Configuration value for ${key} appears to contain sensitive data (${patternName})`,
                severity: 'CRITICAL',
              });
            }
          });
          if (this.looksLikeSecret(value)) {
            errors.push({
              field: key,
              message: `Configuration value for ${key} contains what appears to be a hardcoded secret`,
              severity: 'HIGH',
            });
          }
        }
      });
    }
    if (typeof process !== 'undefined' && process.env) {
      Object.keys(process.env).forEach(key => {
        if (key.startsWith('EXPO_PUBLIC_')) {
          const value = process.env[key];
          if (value) {
            Object.entries(SECURITY_PATTERNS).forEach(([patternName, pattern]) => {
              if (pattern.test(key) || pattern.test(value)) {
                errors.push({
                  field: key,
                  message: `Exposed environment variable ${key} contains sensitive data (${patternName})`,
                  severity: 'CRITICAL',
                });
              }
            });
            if (this.looksLikeSecret(value)) {
              errors.push({
                field: key,
                message: `Exposed environment variable ${key} contains what appears to be a secret`,
                severity: 'CRITICAL',
              });
            }
          }
        }
      });
    }
    return { errors, warnings };
  }
  private validateApiConfiguration(): { errors: FrontendConfigError[]; warnings: FrontendConfigWarning[] } {
    const errors: FrontendConfigError[] = [];
    const warnings: FrontendConfigWarning[] = [];
    const config = Constants.expoConfig;
    const apiBaseUrl = config?.extra?.API_BASE_URL;
    if (apiBaseUrl) {
      try {
        const url = new URL(apiBaseUrl);
        if (url.protocol !== 'https:' && !url.hostname.includes('localhost')) {
          warnings.push({
            field: 'API_BASE_URL',
            message: 'API should use HTTPS for secure communication',
            recommendation: 'Use HTTPS protocol for production API endpoints',
          });
        }
        const isIpAddress = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
        if (isIpAddress && process.env.NODE_ENV === 'production') {
          warnings.push({
            field: 'API_BASE_URL',
            message: 'Using IP address for API URL in production is not recommended',
            recommendation: 'Use domain names instead of IP addresses for production APIs',
          });
        }
        if (url.port && url.port !== '80' && url.port !== '443') {
          warnings.push({
            field: 'API_BASE_URL',
            message: 'Non-standard port detected in API URL',
            recommendation: 'Consider using standard ports (80/443) for production APIs',
          });
        }
      } catch (error) {
        errors.push({
          field: 'API_BASE_URL',
          message: 'Invalid API base URL format',
          severity: 'HIGH',
        });
      }
    }
    return { errors, warnings };
  }
  private calculateSecurityScore(errors: FrontendConfigError[], warnings: FrontendConfigWarning[]): number {
    let score = 100;
    errors.forEach(error => {
      switch (error.severity) {
        case 'CRITICAL':
          score -= 25;
          break;
        case 'HIGH':
          score -= 15;
          break;
        case 'MEDIUM':
          score -= 10;
          break;
        case 'LOW':
          score -= 5;
          break;
      }
    });
    warnings.forEach(() => {
      score -= 2;
    });
    return Math.max(0, score);
  }
  private generateRecommendations(errors: FrontendConfigError[], warnings: FrontendConfigWarning[]): string[] {
    const recommendations: string[] = [];
    if (errors.some(e => e.severity === 'CRITICAL')) {
      recommendations.push('Address critical configuration errors immediately');
    }
    if (errors.some(e => e.field.includes('API_KEY') || e.field.includes('SECRET'))) {
      recommendations.push('Remove all API keys and secrets from frontend configuration');
    }
    if (warnings.some(w => w.field.includes('API_BASE_URL'))) {
      recommendations.push('Review API configuration for security best practices');
    }
    recommendations.push('Use environment-specific configuration for different deployment stages');
    recommendations.push('Regularly audit frontend configuration for exposed sensitive data');
    return recommendations;
  }
  private looksLikeSecret(value: string): boolean {
    const secretPatterns = [
      /^sk-[a-zA-Z0-9]{20,}$/, 
      /^pk_[a-zA-Z0-9]{20,}$/, 
      /^[a-zA-Z0-9]{32,}$/, 
      /^[A-Z0-9]{20,}$/, 
    ];
    return secretPatterns.some(pattern => pattern.test(value));
  }
  public auditExposedVariables(): ExposedVariableAudit[] {
    const audit: ExposedVariableAudit[] = [];
    const config = Constants.expoConfig;
    const extra = config?.extra;
    if (extra) {
      Object.entries(extra).forEach(([key, value]) => {
        if (typeof value === 'string') {
          const auditItem: ExposedVariableAudit = {
            name: key,
            value: value.substring(0, 20) + (value.length > 20 ? '...' : ''), 
            isExposed: true,
            exposureRisk: 'LOW',
          };
          Object.entries(SECURITY_PATTERNS).forEach(([patternName, pattern]) => {
            if (pattern.test(key) || pattern.test(value)) {
              auditItem.exposureRisk = 'CRITICAL';
              auditItem.recommendation = `${key} contains sensitive data (${patternName}). Remove from frontend configuration.`;
            }
          });
          if (this.looksLikeSecret(value)) {
            auditItem.exposureRisk = 'HIGH';
            auditItem.recommendation = `${key} appears to contain a secret. Move to secure backend configuration.`;
          }
          audit.push(auditItem);
        }
      });
    }
    return audit;
  }
  public async auditConfiguration(): Promise<FrontendConfigAudit> {
    const validationResult = await this.validateConfiguration();
    const exposedVariables = this.auditExposedVariables();
    const config = Constants.expoConfig;
    const apiBaseUrl = config?.extra?.API_BASE_URL || '';
    return {
      timestamp: new Date(),
      environment: process.env.NODE_ENV || 'unknown',
      validationResult,
      exposedVariables,
      apiConfiguration: {
        baseUrl: apiBaseUrl,
        isSecure: apiBaseUrl.startsWith('https://') || apiBaseUrl.includes('localhost'),
        usesHttps: apiBaseUrl.startsWith('https://'),
        recommendations: [
          'Use HTTPS for all production API endpoints',
          'Avoid hardcoding API URLs in configuration',
          'Use environment-specific API configurations',
        ],
      },
    };
  }
}
export default ConfigValidationService;