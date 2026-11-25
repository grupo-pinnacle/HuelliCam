import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  createFrontendE2EServer,
  createDefaultVetUser,
  waitForCondition,
  type FrontendE2EServer,
} from '../helpers/dom/frontendHarness';

const repoRoot = path.resolve(__dirname, '../../..');
const socketContextFile = path.join(repoRoot, 'web/src/context/SocketContext.tsx');

describe('Feature 8 (Client): Correlation ID Propagation Across Web, Mobile & Socket.io', () => {
  let server: FrontendE2EServer;

  beforeAll(async () => {
    server = await createFrontendE2EServer();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    server.resetLogs();
    window.localStorage.clear();
  });

  it('T1-F08-05: web api.ts, mobile api.ts, and SocketProvider attach non-empty correlation & request IDs to real Express/Socket.io server', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    vi.stubEnv('EXPO_PUBLIC_API_URL', server.url);

    window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.localStorage.setItem('huellicam_token', 'corr-web-token');

    // 1. Web Axios client
    const webApiModule = await import('@/services/api');
    webApiModule.setAccessToken('corr-web-token');

    await webApiModule.default.get('/health');
    await webApiModule.default.get('/health');

    const webHealthCalls = server.getHttpCalls('GET', '/health');
    expect(webHealthCalls.length).toBe(2);

    const firstReqId = webHealthCalls[0].headers['x-request-id'];
    const secondReqId = webHealthCalls[1].headers['x-request-id'];
    const firstCorrId = webHealthCalls[0].headers['x-correlation-id'];
    const secondCorrId = webHealthCalls[1].headers['x-correlation-id'];

    expect(typeof firstReqId).toBe('string');
    expect(String(firstReqId).trim().length).toBeGreaterThan(0);
    expect(typeof secondReqId).toBe('string');
    expect(String(secondReqId).trim().length).toBeGreaterThan(0);
    expect(firstReqId).not.toBe(secondReqId);

    expect(typeof firstCorrId).toBe('string');
    expect(String(firstCorrId).trim().length).toBeGreaterThan(0);
    expect(typeof secondCorrId).toBe('string');
    expect(String(secondCorrId).trim().length).toBeGreaterThan(0);

    // 2. Mobile Axios client
    server.resetLogs();
    const mobileApiModule = await import('@mobile/lib/api');
    await mobileApiModule.default.get('/health');

    const mobileHealthCalls = server.getHttpCalls('GET', '/health');
    expect(mobileHealthCalls.length).toBe(1);
    expect(mobileHealthCalls[0].headers['x-client-platform']).toBe('mobile');

    const mobileReqId = mobileHealthCalls[0].headers['x-request-id'];
    const mobileCorrId = mobileHealthCalls[0].headers['x-correlation-id'];
    expect(typeof mobileReqId).toBe('string');
    expect(String(mobileReqId).trim().length).toBeGreaterThan(0);
    expect(typeof mobileCorrId).toBe('string');
    expect(String(mobileCorrId).trim().length).toBeGreaterThan(0);

    // 3. Socket.io handshake auth.correlationId via SocketProvider
    expect(fs.existsSync(socketContextFile), 'Expected M2 module web/src/context/SocketContext.tsx to exist').toBe(true);
    const { AuthProvider } = await import('@/context/AuthContext');
    const { SocketProvider } = await import('@/context/SocketContext');

    const view = render(
      <AuthProvider>
        <SocketProvider>
          <div>Correlation Socket</div>
        </SocketProvider>
      </AuthProvider>
    );

    await waitForCondition(() => server.socketConnections.length >= 1, 5000);
    const latestConn = server.socketConnections[server.socketConnections.length - 1];
    expect(typeof latestConn.auth.correlationId).toBe('string');
    expect(String(latestConn.auth.correlationId).trim().length).toBeGreaterThan(0);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });
});
