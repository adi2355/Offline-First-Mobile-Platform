import {
  type MergeContext,
  type MergeResult,
} from '@shared/contracts';
import type { ProductAttributesJson } from '../../../../types';
export interface ProductMergeData {
  id: string;
  userId?: string | null;
  serverId?: string | null;
  clientProductId?: string | null;
  name: string;
  description?: string | null;
  variantGenetics?: string | null;
  typeAPercentage?: number | null;
  typeBPercentage?: number | null;
  genetics?: string | null;
  compoundAContent?: number | string | null;
  compoundBContent?: number | string | null;
  effects?: string[] | null;
  medicalUses?: string[] | null;
  attributes?: ProductAttributesJson | null;
  category?: string | null;
  isPublic?: boolean;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}
function unionArrays<T>(
  arr1: T[] | null | undefined,
  arr2: T[] | null | undefined
): T[] {
  const set = new Set([
    ...(arr1 || []),
    ...(arr2 || []),
  ]);
  return Array.from(set);
}
function mergeProductAttributesJson(
  server: ProductAttributesJson | null | undefined,
  local: ProductAttributesJson | null | undefined
): ProductAttributesJson {
  if (!local) {
    return server ?? {};
  }
  if (!server) {
    return local;
  }
  const merged: ProductAttributesJson = {};
  if (server.attributes || local.attributes) {
    merged.attributes = {
      ...server.attributes,
      ...local.attributes,
    };
  }
  merged.dominant = local.dominant ?? server.dominant;
  if (server.cannabinoids || local.cannabinoids) {
    merged.cannabinoids = {
      ...server.cannabinoids,
      ...local.cannabinoids,
    };
  }
  if (server.flavors || local.flavors) {
    merged.flavors = unionArrays(server.flavors, local.flavors);
  }
  if (local.ratings) {
    merged.ratings = local.ratings;
  } else if (server.ratings) {
    merged.ratings = server.ratings;
  }
  if (server.sideEffects || local.sideEffects) {
    merged.sideEffects = unionArrays(server.sideEffects, local.sideEffects);
  }
  return merged;
}
export function mergeProduct(
  local: ProductMergeData,
  server: ProductMergeData,
  context: MergeContext
): MergeResult<ProductMergeData> {
  const resolvedFromLocal: string[] = [];
  const resolvedFromServer: string[] = [];
  const mergedFields: string[] = [];
  const merged: ProductMergeData = { ...server };
  const localVersion = context.localVersion;
  const serverVersion = context.serverVersion;
  const isLocalNewer = localVersion > serverVersion;
  if (server.isPublic) {
    const newVersion = Math.max(localVersion, serverVersion) + 1;
    return {
      data: { ...merged, version: newVersion, updatedAt: context.now },
      version: newVersion,
      resolvedFromLocal: Object.freeze([]),
      resolvedFromServer: Object.freeze(Object.keys(server)),
      mergedFields: Object.freeze([]),
      updatedAt: context.now,
    };
  }
  if (isLocalNewer) {
    if (local.name && local.name.trim() !== '') {
      merged.name = local.name;
      resolvedFromLocal.push('name');
    } else {
      resolvedFromServer.push('name');
    }
    if (local.description !== undefined) {
      merged.description = local.description;
      resolvedFromLocal.push('description');
    } else {
      resolvedFromServer.push('description');
    }
    if (local.variantGenetics !== undefined) {
      merged.variantGenetics = local.variantGenetics;
      resolvedFromLocal.push('variantGenetics');
    } else {
      resolvedFromServer.push('variantGenetics');
    }
    if (local.typeAPercentage !== undefined) {
      merged.typeAPercentage = local.typeAPercentage;
      resolvedFromLocal.push('typeAPercentage');
    } else {
      resolvedFromServer.push('typeAPercentage');
    }
    if (local.typeBPercentage !== undefined) {
      merged.typeBPercentage = local.typeBPercentage;
      resolvedFromLocal.push('typeBPercentage');
    } else {
      resolvedFromServer.push('typeBPercentage');
    }
    if (local.genetics !== undefined) {
      merged.genetics = local.genetics;
      resolvedFromLocal.push('genetics');
    } else {
      resolvedFromServer.push('genetics');
    }
    if (local.compoundAContent !== undefined) {
      merged.compoundAContent = local.compoundAContent;
      resolvedFromLocal.push('compoundAContent');
    } else {
      resolvedFromServer.push('compoundAContent');
    }
    if (local.compoundBContent !== undefined) {
      merged.compoundBContent = local.compoundBContent;
      resolvedFromLocal.push('compoundBContent');
    } else {
      resolvedFromServer.push('compoundBContent');
    }
    if (local.effects && local.effects.length > 0) {
      merged.effects = unionArrays(server.effects, local.effects);
      mergedFields.push('effects');
    } else {
      resolvedFromServer.push('effects');
    }
    if (local.medicalUses && local.medicalUses.length > 0) {
      merged.medicalUses = unionArrays(server.medicalUses, local.medicalUses);
      mergedFields.push('medicalUses');
    } else {
      resolvedFromServer.push('medicalUses');
    }
    if (local.attributes) {
      merged.attributes = mergeProductAttributesJson(server.attributes, local.attributes);
      mergedFields.push('attributes');
    } else {
      resolvedFromServer.push('attributes');
    }
    if (local.category !== undefined) {
      merged.category = local.category;
      resolvedFromLocal.push('category');
    } else {
      resolvedFromServer.push('category');
    }
  } else {
    resolvedFromServer.push(
      'name', 'description', 'variantGenetics', 'typeAPercentage',
      'typeBPercentage', 'genetics', 'compoundAContent', 'compoundBContent',
      'effects', 'medicalUses', 'attributes', 'category'
    );
  }
  merged.id = local.id ?? server.id;
  if (local.id) {
    resolvedFromLocal.push('id');
  } else {
    resolvedFromServer.push('id');
  }
  if (server.id !== undefined) {
    merged.serverId = server.id;
    resolvedFromServer.push('serverId');
  } else if (local.serverId !== undefined) {
    merged.serverId = local.serverId;
    resolvedFromLocal.push('serverId');
  }
  merged.userId = server.userId;
  resolvedFromServer.push('userId');
  merged.clientProductId = server.clientProductId ?? local.clientProductId;
  if (server.clientProductId != null) {
    resolvedFromServer.push('clientProductId');
  } else if (local.clientProductId != null) {
    resolvedFromLocal.push('clientProductId');
  }
  merged.isPublic = server.isPublic;
  resolvedFromServer.push('isPublic');
  merged.createdAt = server.createdAt;
  resolvedFromServer.push('createdAt');
  const newVersion = Math.max(localVersion, serverVersion) + 1;
  merged.version = newVersion;
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
