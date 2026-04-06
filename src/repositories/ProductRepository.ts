import { BaseAPIRepository, PaginatedResponse, ListParams, APIError } from './BaseAPIRepository';
import { Product, ProductType, VariantGenetics, ProductAttributesJson } from '../types';
import { logger } from '../utils/logger';
import {
  ProductSchema,
  ApiResponseSchema,
  PaginatedResponseSchema,
  formatValidationErrors
} from '../utils/ValidationSchemas';
import {
  validateUUID,
  validateCompoundAContent,
  validateCompoundBContent,
  validatePagination
} from '../utils/validators';
import { BackendAPIClient } from '../services/api/BackendAPIClient';
import { z } from 'zod';
export interface ProductSearchFilters {
  type?: ProductType;
  variantGenetics?: VariantGenetics;
  effects?: string[];
  medicalUses?: string[];
  minCompoundA?: number;
  maxCompoundA?: number;
  minCbd?: number;
  maxCbd?: number;
  category?: string;
}
export interface ProductSearchResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  facets?: Record<string, number>;
}
export interface CreateProductData {
  name: string;
  type?: ProductType;
  category?: string;
  compoundAContent?: number;
  compoundBContent?: number;
  attributes?: ProductAttributesJson | Record<string, number>;
  description?: string;
  effects?: string[];
  medicalUses?: string[];
  variantGenetics?: VariantGenetics;
  typeAPercentage?: number;
  typeBPercentage?: number;
  genetics?: string;
}
export interface UpdateProductData extends Partial<CreateProductData> {
  version?: number;
}
export class ProductRepository extends BaseAPIRepository<Product> {
  protected readonly entityName = 'Product';
  protected readonly baseEndpoint = '/products';
  constructor(apiClient: BackendAPIClient) {
    super(apiClient);
    logger.debug('[ProductRepository] Initialized with API-driven architecture');
  }
  async create(data: CreateProductData | Record<string, unknown>): Promise<Product> {
    this.validateRequired(data, 'data');
    const productData = data as CreateProductData;
    this.validateRequired(productData.name, 'data.name');
    if (productData.name && productData.name.trim().length === 0) {
      throw new Error('Product name cannot be empty');
    }
    if (productData.compoundAContent !== undefined) {
      validateCompoundAContent(productData.compoundAContent);
    }
    if (productData.compoundBContent !== undefined) {
      validateCompoundBContent(productData.compoundBContent);
    }
    try {
      const response = await this.apiPost(`${this.baseEndpoint}/user`, data);
      const validatedResponse = this.validateAPIResponse(response, 'create');
      const validatedProduct = this.validateResponse(validatedResponse, ProductSchema, 'create');
      const product = this.transformToProduct(validatedProduct);
      this.logSuccess('create', {
        productId: product.id,
        name: product.name,
        type: product.type
      });
      return product;
    } catch (error) {
      throw this.handleAPIError(error, 'create');
    }
  }
  async getById(id: string): Promise<Product | null> {
    validateUUID(id, 'product ID');
    try {
      const response = await this.apiGet(`${this.baseEndpoint}/${id}`);
      const validatedResponse = this.validateAPIResponse(response, 'getById');
      const validatedProduct = this.validateResponse(validatedResponse, ProductSchema, 'getById');
      const product = this.transformToProduct(validatedProduct);
      this.logSuccess('getById', {
        productId: id,
        found: true,
        isPublic: product.isPublic
      });
      return product;
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
        this.logSuccess('getById', { productId: id, found: false });
        return null;
      }
      throw this.handleAPIError(error, 'getById');
    }
  }
  async update(id: string, data: Partial<CreateProductData>): Promise<Product> {
    validateUUID(id, 'product ID');
    this.validateRequired(data, 'data');
    if (Object.keys(data).length === 0) {
      throw new Error('Update data cannot be empty');
    }
    if (data.compoundAContent !== undefined) {
      validateCompoundAContent(data.compoundAContent);
    }
    if (data.compoundBContent !== undefined) {
      validateCompoundBContent(data.compoundBContent);
    }
    try {
      const response = await this.apiPut(`${this.baseEndpoint}/${id}`, data);
      const validatedResponse = this.validateAPIResponse(response, 'update');
      const validatedProduct = this.validateResponse(validatedResponse, ProductSchema, 'update');
      const product = this.transformToProduct(validatedProduct);
      this.logSuccess('update', {
        productId: id,
        updatedFields: Object.keys(data),
        name: product.name
      });
      return product;
    } catch (error) {
      throw this.handleAPIError(error, 'update');
    }
  }
  async delete(id: string): Promise<void> {
    validateUUID(id, 'product ID');
    try {
      await this.apiDelete(`${this.baseEndpoint}/${id}`);
      this.logSuccess('delete', {
        productId: id,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      throw this.handleAPIError(error, 'delete');
    }
  }
  async list(params?: ListParams): Promise<PaginatedResponse<Product>> {
    validatePagination(params?.page, params?.pageSize);
    try {
      const response = await this.apiGetList(this.baseEndpoint, params);
      const validatedPaginatedResponse = this.validatePaginatedResponse(response, ProductSchema, 'list');
      const validatedResponse: PaginatedResponse<Product> = {
        ...validatedPaginatedResponse,
        items: this.transformToProductArray(validatedPaginatedResponse.items)
      };
      this.logSuccess('list', {
        total: validatedResponse.total,
        page: validatedResponse.page,
        pageSize: validatedResponse.pageSize,
        hasMore: validatedResponse.hasMore
      });
      return validatedResponse;
    } catch (error) {
      throw this.handleAPIError(error, 'list');
    }
  }
  async getPublicCatalog(params: ListParams = {}): Promise<PaginatedResponse<Product>> {
    validatePagination(params.page, params.pageSize);
    try {
      const response = await this.apiGetList(`${this.baseEndpoint}/catalog`, params);
      const validatedPaginatedResponse = this.validatePaginatedResponse(response, ProductSchema, 'getPublicCatalog');
      const validatedResponse: PaginatedResponse<Product> = {
        ...validatedPaginatedResponse,
        items: this.transformToProductArray(validatedPaginatedResponse.items)
      };
      this.logSuccess('getPublicCatalog', {
        total: validatedResponse.total,
        page: validatedResponse.page,
        publicProductsCount: validatedResponse.items.filter(p => p.isPublic).length
      });
      return validatedResponse;
    } catch (error) {
      throw this.handleAPIError(error, 'getPublicCatalog');
    }
  }
  async getUserProducts(params: ListParams = {}): Promise<PaginatedResponse<Product>> {
    validatePagination(params.page, params.pageSize);
    try {
      const response = await this.apiGetList(`${this.baseEndpoint}/user`, params);
      const validatedPaginatedResponse = this.validatePaginatedResponse(response, ProductSchema, 'getUserProducts');
      const validatedResponse: PaginatedResponse<Product> = {
        ...validatedPaginatedResponse,
        items: this.transformToProductArray(validatedPaginatedResponse.items)
      };
      this.logSuccess('getUserProducts', {
        total: validatedResponse.total,
        page: validatedResponse.page,
        userProductsCount: validatedResponse.items.filter(p => !p.isPublic).length
      });
      return validatedResponse;
    } catch (error) {
      throw this.handleAPIError(error, 'getUserProducts');
    }
  }
  async searchProducts(
    query: string,
    filters: ProductSearchFilters = {},
    params: ListParams = {}
  ): Promise<ProductSearchResult<Product>> {
    if (query && query.length > 500) {
      throw new Error('Search query too long (max 500 characters)');
    }
    validatePagination(params.page, params.pageSize);
    if (filters.minCompoundA !== undefined) {
      validateCompoundAContent(filters.minCompoundA, 'Minimum compound-A');
    }
    if (filters.maxCompoundA !== undefined) {
      validateCompoundAContent(filters.maxCompoundA, 'Maximum compound-A');
    }
    if (filters.minCompoundA && filters.maxCompoundA && filters.minCompoundA > filters.maxCompoundA) {
      throw new Error('Minimum compound-A cannot be greater than maximum compound-A');
    }
    try {
      const searchParams = {
        ...params,
        filters: {
          ...params.filters,
          q: query?.trim() || '',
          ...filters,
        }
      };
      const response = await this.apiGetList(`${this.baseEndpoint}/search`, searchParams);
      const validatedResponse = this.validatePaginatedResponse(response, ProductSchema, 'searchProducts');
      const searchResult: ProductSearchResult<Product> = {
        items: this.transformToProductArray(validatedResponse.items),
        total: validatedResponse.total,
        page: validatedResponse.page,
        pageSize: validatedResponse.pageSize,
        hasMore: validatedResponse.hasMore,
        facets: {}, 
      };
      this.logSuccess('searchProducts', {
        query: query?.substring(0, 50), 
        filtersApplied: Object.keys(filters).length,
        resultsCount: searchResult.items.length,
        totalResults: searchResult.total
      });
      return searchResult;
    } catch (error) {
      throw this.handleAPIError(error, 'searchProducts');
    }
  }
  async getPopularProducts(limit: number = 10): Promise<Product[]> {
    if (limit < 1 || limit > 50) {
      throw new Error('Limit must be between 1 and 50');
    }
    try {
      const response = await this.apiGet(`${this.baseEndpoint}/popular`, { limit });
      const validatedResponse = this.validateAPIResponse(response, 'getPopularProducts');
      const validatedProducts = z.array(ProductSchema).parse(validatedResponse);
      const productsArray = this.transformToProductArray(validatedProducts);
      this.logSuccess('getPopularProducts', {
        limit,
        count: productsArray.length,
        topProduct: productsArray[0]?.name || 'None',
        averageThc: productsArray.reduce((sum, p) => sum + (p.compoundAContent || 0), 0) / productsArray.length || 0
      });
      return productsArray;
    } catch (error) {
      throw this.handleAPIError(error, 'getPopularProducts');
    }
  }
  async getRecommendations(limit: number = 5): Promise<Product[]> {
    if (limit < 1 || limit > 20) {
      throw new Error('Recommendations limit must be between 1 and 20');
    }
    try {
      const response = await this.apiGet(`${this.baseEndpoint}/recommendations`, { limit });
      const validatedResponse = this.validateAPIResponse(response, 'getRecommendations');
      const validatedProducts = z.array(ProductSchema).parse(validatedResponse);
      const productsArray = this.transformToProductArray(validatedProducts);
      this.logSuccess('getRecommendations', {
        limit,
        count: productsArray.length,
        recommendationTypes: productsArray.map(p => p.type),
        averageMatchScore: 85 
      });
      return productsArray;
    } catch (error) {
      throw this.handleAPIError(error, 'getRecommendations');
    }
  }
  async createProduct(data: CreateProductData): Promise<Product> {
    return this.create(data);
  }
  async updateProduct(id: string, data: UpdateProductData): Promise<Product> {
    return this.update(id, data);
  }
  async deleteProduct(id: string): Promise<void> {
    return this.delete(id);
  }
  async getStrainById(id: number): Promise<Product | null> {
    logger.warn('getStrainById is deprecated, use getById with UUID instead', { legacyId: id });
    return null;
  }
  async getPopularStrains(limit: number = 10): Promise<Product[]> {
    logger.warn('getPopularStrains is deprecated, use getPopularProducts instead');
    return this.getPopularProducts(limit);
  }
  async searchStrains(
    query: string,
    filters: Record<string, unknown> = {},
    pagination: { page?: number; limit?: number } = { page: 1, limit: 10 }
  ): Promise<ProductSearchResult<Product>> {
    logger.warn('searchStrains is deprecated, use searchProducts instead');
    const newFilters: ProductSearchFilters = {};
    if (filters.geneticType && typeof filters.geneticType === 'string') {
      newFilters.variantGenetics = filters.geneticType as VariantGenetics;
    }
    if (filters.effects && Array.isArray(filters.effects)) {
      newFilters.effects = filters.effects as string[];
    }
    return this.searchProducts(query, newFilters, {
      page: pagination.page,
      pageSize: pagination.limit
    });
  }
  async getStrainsByIds(ids: number[]): Promise<Product[]> {
    logger.warn('getStrainsByIds is deprecated, numeric IDs are no longer supported');
    return [];
  }
  async getRelatedStrains(variant: Product): Promise<Product[]> {
    logger.warn('getRelatedStrains is deprecated, use search with similar filters instead');
    if (!variant.variantGenetics && !variant.effects?.length) {
      return [];
    }
    try {
      const filters: ProductSearchFilters = {};
      if (variant.variantGenetics) {
        filters.variantGenetics = variant.variantGenetics;
      }
      if (variant.effects?.length) {
        filters.effects = variant.effects.slice(0, 2); 
      }
      const result = await this.searchProducts('', filters, { pageSize: 5 });
      return result.items.filter(p => p.id !== variant.id);
    } catch (error) {
      const errorInfo = error instanceof Error ?
        { name: error.name, message: error.message, stack: error.stack } :
        { name: 'UnknownError', message: String(error) };
      logger.error('Failed to get related variants', {
        strainId: variant.id,
        error: errorInfo
      });
      return [];
    }
  }
  async getStrainCategories(): Promise<{ [key: string]: number }> {
    logger.warn('getStrainCategories is deprecated, use search with facets instead');
    return {};
  }
  private transformToProduct(validatedData: z.infer<typeof ProductSchema>): Product {
    const dataWithRelations = validatedData as z.infer<typeof ProductSchema> & {
      user?: unknown;
      consumptions?: unknown[];
      purchases?: unknown[];
      purchaseItems?: unknown[];
    };
    return {
      id: validatedData.id,
      userId: validatedData.userId || '', 
      isPublic: validatedData.isPublic,
      name: validatedData.name,
      type: validatedData.type as ProductType,
      variantGenetics: validatedData.variantGenetics as VariantGenetics | null | undefined,
      typeAPercentage: validatedData.typeAPercentage,
      typeBPercentage: validatedData.typeBPercentage,
      genetics: validatedData.genetics,
      compoundAContent: validatedData.compoundAContent,
      compoundBContent: validatedData.compoundBContent,
      attributes: validatedData.attributes,
      description: validatedData.description,
      effects: validatedData.effects || [], 
      medicalUses: validatedData.medicalUses || [], 
      category: validatedData.category,
      createdAt: validatedData.createdAt,
      updatedAt: validatedData.updatedAt,
      user: dataWithRelations.user as never,
      consumptions: dataWithRelations.consumptions as never,
      purchases: dataWithRelations.purchases as never,
      purchaseItems: dataWithRelations.purchaseItems as never,
    };
  }
  private transformToProductArray(validatedProducts: z.infer<typeof ProductSchema>[]): Product[] {
    return validatedProducts.map(item => this.transformToProduct(item));
  }
}