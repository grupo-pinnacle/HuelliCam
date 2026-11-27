import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import api from '../services/api';

describe('Axios GET retry boundaries (no 500 retry amplification)', () => {
  const originalAdapter = api.defaults.adapter;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    api.defaults.adapter = originalAdapter;
  });

  it('does NOT retry GET requests that return HTTP 500', async () => {
    const adapterMock = vi.fn<AxiosAdapter>().mockImplementation(async (config: InternalAxiosRequestConfig) => {
      throw {
        isAxiosError: true,
        config,
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: { success: false },
          headers: {},
          config,
        },
      };
    });
    api.defaults.adapter = adapterMock;

    await expect(api.get('/api/pets')).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(adapterMock).toHaveBeenCalledTimes(1);
  });

  it('retries GET requests at most once on HTTP 503 and resolves if retry succeeds', async () => {
    let attempt = 0;
    const adapterMock = vi.fn<AxiosAdapter>().mockImplementation(async (config: InternalAxiosRequestConfig) => {
      attempt += 1;
      if (attempt === 1) {
        throw {
          isAxiosError: true,
          config,
          response: {
            status: 503,
            statusText: 'Service Unavailable',
            data: { success: false },
            headers: {},
            config,
          },
        };
      }
      return {
        data: { success: true, data: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    });
    api.defaults.adapter = adapterMock;

    const res = await api.get('/api/pets');
    expect(res.status).toBe(200);
    expect(adapterMock).toHaveBeenCalledTimes(2);
  });
});
