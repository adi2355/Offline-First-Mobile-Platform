import type { EntityColumnConfig } from '../types';
import {
  toJsonArray,
  toJsonObject,
  toBooleanInt,
} from '../transforms';
export const PRODUCTS_CONFIG: EntityColumnConfig = {
  baseColumns: {
    hasServerId: true,
    hasData: false,
    createdAtColumn: 'createdAt',  
    updatedAtColumn: 'updatedAt',  
  },
  requiredColumns: [
    { backendField: 'userId', sqliteColumn: 'userId' },           
    { backendField: 'clientProductId', sqliteColumn: 'clientProductId' },
    { backendField: 'name', sqliteColumn: 'name' },
    { backendField: 'variantGenetics', sqliteColumn: 'variantGenetics' }, 
    { backendField: 'type', sqliteColumn: 'type' },
    { backendField: 'category', sqliteColumn: 'category' },
    { backendField: 'compoundAContent', sqliteColumn: 'compoundAContent' },   
    { backendField: 'compoundBContent', sqliteColumn: 'compoundBContent' },   
    { backendField: 'typeAPercentage', sqliteColumn: 'typeAPercentage' }, 
    { backendField: 'typeBPercentage', sqliteColumn: 'typeBPercentage' }, 
    { backendField: 'genetics', sqliteColumn: 'genetics' },
    { backendField: 'attributes', sqliteColumn: 'attributes', transform: toJsonObject },
    { backendField: 'description', sqliteColumn: 'description' },
    { backendField: 'effects', sqliteColumn: 'effects', transform: toJsonArray },
    { backendField: 'medicalUses', sqliteColumn: 'medicalUses', transform: toJsonArray }, 
    { backendField: 'isPublic', sqliteColumn: 'isPublic', transform: toBooleanInt },
    { backendField: 'version', sqliteColumn: 'version' },
  ],
  syncMode: 'SYNCED',
  clientIdBackendField: 'clientProductId',
};
export const PRODUCTS_USER_COLUMN = 'userId';
