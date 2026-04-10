import {
  type EntityType,
  getFkFieldToEntityMap,
  getForeignKeyRelations,
} from '@shared/contracts';
import { logger } from '../../../utils/logger';
export interface IdMappingLookup {
  getClientId(serverId: string): Promise<string | null>;
}
export interface FkResolutionResult {
  readonly serverValue: string | null;
  readonly resolvedValue: string | null;
  readonly wasMapped: boolean;
  readonly targetEntity: EntityType;
}
export type FkResolutionErrorCode = 'REQUIRED_FK_MISSING' | 'INVALID_FK_VALUE';
export class ForeignKeyResolutionError extends Error {
  readonly code: FkResolutionErrorCode;
  readonly entityType: EntityType;
  readonly fieldName: string;
  readonly targetEntity: EntityType;
  readonly serverValue: string;
  constructor(
    entityType: EntityType,
    fieldName: string,
    targetEntity: EntityType,
    serverValue: string,
    code: FkResolutionErrorCode
  ) {
    const message =
      `[ForeignKeyResolver] FK "${fieldName}" in "${entityType}" has invalid value. ` +
      `Target entity "${targetEntity}" with value "${serverValue}" is invalid. ` +
      `Code: ${code}`;
    super(message);
    this.name = 'ForeignKeyResolutionError';
    this.code = code;
    this.entityType = entityType;
    this.fieldName = fieldName;
    this.targetEntity = targetEntity;
    this.serverValue = serverValue;
  }
}
export interface FkResolutionReport<T> {
  readonly data: T;
  readonly resolutions: ReadonlyMap<string, FkResolutionResult>;
  readonly resolvedFields: readonly string[];
  readonly unresolvedFields: readonly string[];
}
export class ForeignKeyResolver {
  constructor(private readonly idLookup: IdMappingLookup) {}
  async resolveInboundForeignKeys<T extends Record<string, unknown>>(
    entityType: EntityType,
    serverData: T
  ): Promise<FkResolutionReport<T>> {
    const fkFieldMap = getFkFieldToEntityMap(entityType);
    if (fkFieldMap.size === 0) {
      return {
        data: serverData,
        resolutions: new Map(),
        resolvedFields: [],
        unresolvedFields: [],
      };
    }
    const resolvedData = { ...serverData } as Record<string, unknown>;
    const resolutions = new Map<string, FkResolutionResult>();
    const resolvedFields: string[] = [];
    const unresolvedFields: string[] = [];
    for (const [fieldName, targetEntity] of fkFieldMap) {
      const serverValue = serverData[fieldName];
      if (serverValue === undefined || serverValue === null) {
        continue;
      }
      if (typeof serverValue !== 'string') {
        logger.warn('[ForeignKeyResolver] FK field is not a string', {
          entityType,
          fieldName,
          valueType: typeof serverValue,
        });
        continue;
      }
      const clientId = await this.idLookup.getClientId(serverValue);
      if (clientId) {
        resolvedData[fieldName] = clientId;
        resolvedFields.push(fieldName);
        resolutions.set(fieldName, {
          serverValue,
          resolvedValue: clientId,
          wasMapped: true,
          targetEntity,
        });
        logger.debug('[ForeignKeyResolver] Resolved FK', {
          entityType,
          fieldName,
          targetEntity,
          serverValue,
          clientId,
        });
      } else {
        const relations = getForeignKeyRelations(entityType);
        const relation = relations.find(r => r.sourceField === fieldName);
        const isOptional = relation?.optional ?? true;
        unresolvedFields.push(fieldName);
        resolutions.set(fieldName, {
          serverValue,
          resolvedValue: serverValue,
          wasMapped: false,
          targetEntity,
        });
        if (isOptional) {
          logger.debug('[ForeignKeyResolver] Optional FK unresolved, keeping server ID', {
            entityType,
            fieldName,
            targetEntity,
            serverValue,
            reason: 'No id_map entry found (expected for server-originated entities)',
          });
        } else {
          logger.info('[ForeignKeyResolver] Required FK unresolved, keeping server ID', {
            entityType,
            fieldName,
            targetEntity,
            serverValue,
            reason: 'No id_map entry found - target is likely server-originated or Model A after cascade',
          });
        }
      }
    }
    return {
      data: resolvedData as T,
      resolutions,
      resolvedFields: Object.freeze(resolvedFields),
      unresolvedFields: Object.freeze(unresolvedFields),
    };
  }
  async resolveSingleFk(
    sourceEntity: EntityType,
    fieldName: string,
    serverValue: string
  ): Promise<string> {
    const clientId = await this.idLookup.getClientId(serverValue);
    if (clientId) {
      logger.debug('[ForeignKeyResolver] Single FK resolved', {
        sourceEntity,
        fieldName,
        serverValue,
        clientId,
      });
      return clientId;
    }
    const relations = getForeignKeyRelations(sourceEntity);
    const relation = relations.find(r => r.sourceField === fieldName);
    const isOptional = relation?.optional ?? true;
    if (isOptional) {
      logger.debug('[ForeignKeyResolver] Single optional FK unresolved, keeping server ID', {
        sourceEntity,
        fieldName,
        serverValue,
        targetEntity: relation?.targetEntity,
        reason: 'No id_map entry (expected for server-originated entities)',
      });
    } else {
      logger.info('[ForeignKeyResolver] Single required FK unresolved, keeping server ID', {
        sourceEntity,
        fieldName,
        serverValue,
        targetEntity: relation?.targetEntity,
        reason: 'No id_map entry - target is likely server-originated or Model A after cascade',
      });
    }
    return serverValue;
  }
  hasForeignKeys(entityType: EntityType): boolean {
    const relations = getForeignKeyRelations(entityType);
    return relations.length > 0;
  }
  static getSummary<T>(report: FkResolutionReport<T>): string {
    const totalFks = report.resolutions.size;
    const resolved = report.resolvedFields.length;
    const unresolved = report.unresolvedFields.length;
    if (totalFks === 0) {
      return 'No FK fields';
    }
    return `${resolved}/${totalFks} FKs resolved (${unresolved} kept server ID)`;
  }
}
export function createForeignKeyResolver(
  idLookup: IdMappingLookup
): ForeignKeyResolver {
  return new ForeignKeyResolver(idLookup);
}
