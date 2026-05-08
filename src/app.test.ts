import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('./db/inventory', () => ({
  getHosts: vi.fn(),
  getWorkloads: vi.fn(),
}));

import { app } from './app';

async function getMockedInventory() {
  const inventoryModule = await import('./db/inventory');
  return inventoryModule as unknown as {
    getHosts: ReturnType<typeof vi.fn>;
    getWorkloads: ReturnType<typeof vi.fn>;
  };
}

describe('App route mounting', () => {
  it('GET /api/v1/inventory responds with 200 when authenticated', async () => {
    const inventory = await getMockedInventory();
    inventory.getHosts.mockResolvedValue([]);
    inventory.getWorkloads.mockResolvedValue([]);

    // Auth middleware requires either oauth2-proxy headers or MOCK_USER_EMAIL
    // env. Simulate the production header path here.
    const response = await request(app)
      .get('/api/v1/inventory')
      .set('X-Forwarded-Email', 'test@example.com')
      .set('X-Forwarded-User', 'test')
      .set('X-Forwarded-Groups', 'mc-admins');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        hosts: [],
        workloads: [],
      },
    });
  });

  it('GET /api/v1/inventory returns 401 without auth headers', async () => {
    const response = await request(app).get('/api/v1/inventory');
    expect(response.status).toBe(401);
  });
});
