interface FetchWithRetryOptions {
  maxRetries?: number;
  timeout?: number;
  initialBackoff?: number;
  maxBackoff?: number;
  correlationId?: string;
  fetchOptions?: RequestInit;
}
interface FetchError extends Error {
  statusCode?: number;
  correlationId?: string;
}
function calculateBackoff(
  attempt: number,
  initialBackoff: number,
  maxBackoff: number
): number {
  const exponentialDelay = initialBackoff * Math.pow(2, attempt);
  const jitter = Math.random() * 1000; 
  const delay = Math.min(maxBackoff, exponentialDelay + jitter);
  return delay;
}
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const {
    maxRetries = 3,
    timeout = 10000,
    initialBackoff = 1000,
    maxBackoff = 10000,
    correlationId = 'no-correlation-id',
    fetchOptions = {}
  } = options;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      console.log(
        `[fetchWithRetry] Attempt ${attempt + 1}/${maxRetries + 1} for URL: ${url}, CorrelationId: ${correlationId}`
      );
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        console.log(
          `[fetchWithRetry] Success on attempt ${attempt + 1}, CorrelationId: ${correlationId}`
        );
        return response;
      }
      const error: FetchError = new Error(
        `HTTP error! Status: ${response.status} ${response.statusText}`
      );
      error.statusCode = response.status;
      error.correlationId = correlationId;
      if (response.status >= 400 && response.status < 500) {
        console.error(
          `[fetchWithRetry] Client error (${response.status}), not retrying. CorrelationId: ${correlationId}`
        );
        throw error;
      }
      lastError = error;
      console.warn(
        `[fetchWithRetry] Server error (${response.status}), attempt ${attempt + 1} failed. CorrelationId: ${correlationId}`
      );
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        const timeoutError: FetchError = new Error(
          `Request timeout after ${timeout}ms`
        );
        timeoutError.correlationId = correlationId;
        lastError = timeoutError;
        console.warn(
          `[fetchWithRetry] Timeout on attempt ${attempt + 1}. CorrelationId: ${correlationId}`
        );
      } else if (fetchError instanceof Error) {
        lastError = fetchError;
        console.warn(
          `[fetchWithRetry] Network error on attempt ${attempt + 1}: ${fetchError.message}, CorrelationId: ${correlationId}`
        );
      } else {
        lastError = new Error('Unknown fetch error');
        console.warn(
          `[fetchWithRetry] Unknown error on attempt ${attempt + 1}. CorrelationId: ${correlationId}`
        );
      }
    }
    if (attempt < maxRetries) {
      const backoffDelay = calculateBackoff(attempt, initialBackoff, maxBackoff);
      console.log(
        `[fetchWithRetry] Retrying in ${backoffDelay}ms... CorrelationId: ${correlationId}`
      );
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
  const finalError: FetchError = new Error(
    `Failed to fetch after ${maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`
  );
  finalError.correlationId = correlationId;
  console.error(
    `[fetchWithRetry] All retry attempts exhausted. CorrelationId: ${correlationId}`
  );
  throw finalError;
}
export async function fetchJSONWithRetry<T = unknown>(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<T> {
  const response = await fetchWithRetry(url, options);
  try {
    const jsonData: unknown = await response.json();
    return jsonData as T;
  } catch (parseError: unknown) {
    const error = parseError instanceof Error
      ? parseError
      : new Error('Failed to parse JSON response');
    console.error(
      `[fetchJSONWithRetry] JSON parse error. CorrelationId: ${options.correlationId || 'no-correlation-id'}`,
      error
    );
    throw error;
  }
}
