import {
  WEB_TOKEN_STORAGE_KEY,
  WEB_USER_STORAGE_KEY,
  buildAuthSeedScript,
  buildNativeNavigateScript,
  isCallRouteUrl,
  isLoopbackUrl,
  parseHost,
  parseWebViewBridgeMessage,
  resolveWebAppUrl,
  resolveWebBaseUrlConfig,
  resolveWebCallUrl,
  shouldOpenExternally,
  HARDENED_WEBVIEW_CONFIG,
  handleContentProcessTermination,
} from '../lib/webviewBridge';
import { User } from '../types';

/**
 * Exercises the real production helpers in `src/lib/webviewBridge.ts`.
 *
 * The previous version of this file built the dead `window.initLiveKitCall`
 * string inside the test body and asserted that the string it had just built
 * contained its own token. That identifier has zero occurrences in `web/`.
 */
const user = {
  id: 'user-1',
  email: 'tutor@example.com',
  firstName: 'Ana',
  lastName: 'Ruiz',
  role: 'CLIENT',
  ratingAvg: 0,
  ratingCount: 0,
  isOnline: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as User;

describe('web client credential seeding', () => {
  const script = buildAuthSeedScript('jwt-abc', user);

  it('uses the storage keys the web client actually reads', () => {
    // web/src/services/api.ts and web/src/context/AuthContext.tsx
    expect(WEB_TOKEN_STORAGE_KEY).toBe('huellicam_token');
    expect(WEB_USER_STORAGE_KEY).toBe('huellicam_user');
  });

  it('seeds both keys before the page scripts run', () => {
    expect(script).toContain(`window.localStorage.setItem("huellicam_token","jwt-abc")`);
    expect(script).toContain(`window.localStorage.setItem("huellicam_user",`);
    expect(script).toContain('"id":"user-1"');
  });

  it('evaluates to true, as react-native-webview requires', () => {
    expect(script.trimEnd().endsWith('true;')).toBe(true);
  });

  it('swallows a storage failure instead of aborting the document', () => {
    expect(script).toContain('try{');
    expect(script).toContain('}catch(e){};');
  });

  it('does not reference the dead initLiveKitCall bridge', () => {
    expect(script).not.toContain('initLiveKitCall');
  });

  it('escapes a token containing quote characters', () => {
    // Guards against breaking out of the injected string literal.
    const escaped = buildAuthSeedScript('a"b\\c', user);
    expect(escaped).toContain('window.localStorage.setItem("huellicam_token","a\\"b\\\\c")');
  });
});

describe('web call base URL resolution', () => {
  it('joins the base URL and the call path', () => {
    expect(resolveWebCallUrl('https://app.huellicam.com.ar', 'cons-1')).toBe(
      'https://app.huellicam.com.ar/call/cons-1'
    );
  });

  it('does not double the separator when the base URL has a trailing slash', () => {
    expect(resolveWebCallUrl('https://app.huellicam.com.ar/', 'cons-1')).toBe(
      'https://app.huellicam.com.ar/call/cons-1'
    );
  });

  it('preserves a non-default port', () => {
    expect(resolveWebCallUrl('http://192.168.1.10:5173', 'cons-1')).toBe(
      'http://192.168.1.10:5173/call/cons-1'
    );
  });

  it('encodes the consultation id', () => {
    expect(resolveWebCallUrl('https://app.huellicam.com.ar', 'a b')).toBe(
      'https://app.huellicam.com.ar/call/a%20b'
    );
  });
});

describe('loopback base URL detection', () => {
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://0.0.0.0:5173', 'http://[::1]:5173'])(
    'flags %s as resolving to the handset itself',
    (url) => {
      expect(isLoopbackUrl(url)).toBe(true);
    }
  );

  it.each([
    'https://app.huellicam.com.ar',
    'http://192.168.1.10:5173',
    'https://localhost.example.com',
    'http://mylocalhost:5173',
  ])('does not flag %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it('does not throw on a value that is not a URL', () => {
    expect(isLoopbackUrl('')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });

  it('parses the host without relying on a complete URL implementation', () => {
    // Hermes ships a partial `URL`; this is regex based on purpose.
    expect(parseHost('https://user:pw@app.huellicam.com.ar:8443/x')).toBe(
      'app.huellicam.com.ar'
    );
    expect(parseHost('http://[::1]:5173')).toBe('::1');
    expect(parseHost('nonsense')).toBeNull();
  });
});

describe('BUG-07: Hardened React Native WebView Configuration', () => {
  it('enforces localStorage and cookie session persistence', () => {
    expect(HARDENED_WEBVIEW_CONFIG.domStorageEnabled).toBe(true);
    expect(HARDENED_WEBVIEW_CONFIG.javaScriptEnabled).toBe(true);
    expect(HARDENED_WEBVIEW_CONFIG.sharedCookiesEnabled).toBe(true);
    expect(HARDENED_WEBVIEW_CONFIG.thirdPartyCookiesEnabled).toBe(true);
  });

  it('enforces seamless inline WebRTC audio/video playback and capture', () => {
    expect(HARDENED_WEBVIEW_CONFIG.allowsInlineMediaPlayback).toBe(true);
    expect(HARDENED_WEBVIEW_CONFIG.mediaPlaybackRequiresUserAction).toBe(false);
    expect(HARDENED_WEBVIEW_CONFIG.mediaCapturePermissionGrantType).toBe('grant');
  });

  it('enforces allowFileAccess for native Android/iOS file picker', () => {
    expect(HARDENED_WEBVIEW_CONFIG.allowFileAccess).toBe(true);
  });

  it('reloads webview safely when content process terminates in background', () => {
    const mockReload = jest.fn();
    const result = handleContentProcessTermination({ nativeEvent: {} }, { reload: mockReload });

    expect(result).toBe(true);
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('does not crash or reload if termination event lacks nativeEvent or webview ref', () => {
    expect(handleContentProcessTermination({}, null)).toBe(false);
    expect(handleContentProcessTermination({ nativeEvent: {} }, null)).toBe(false);
  });
});

describe('100% WebView Shell bridge helpers', () => {
  it('resolves dev localhost default and rejects missing/loopback URL in standalone release', () => {
    expect(resolveWebBaseUrlConfig(undefined, true)).toEqual({
      url: 'http://localhost:5173',
      error: null,
    });
    expect(resolveWebBaseUrlConfig(undefined, false).url).toBeNull();
    expect(resolveWebBaseUrlConfig('http://localhost:5173', false).url).toBeNull();
    expect(resolveWebBaseUrlConfig('https://app.huellicam.com.ar/', false)).toEqual({
      url: 'https://app.huellicam.com.ar',
      error: null,
    });
  });

  it('builds SPA URLs cleanly and detects /call/* routes', () => {
    expect(resolveWebAppUrl('https://app.huellicam.com.ar/', 'login')).toBe(
      'https://app.huellicam.com.ar/login'
    );
    expect(isCallRouteUrl('http://localhost:5173/call/cons-1?from=client')).toBe(true);
    expect(isCallRouteUrl('http://localhost:5173/client/dashboard')).toBe(false);
  });

  it('keeps same-origin navigation inside WebView and delegates external URLs', () => {
    const appBase = 'https://app.huellicam.com.ar';
    expect(shouldOpenExternally('https://app.huellicam.com.ar/client/pets', appBase)).toBe(false);
    expect(shouldOpenExternally('about:blank', appBase)).toBe(false);
    expect(shouldOpenExternally('https://mercadopago.com.ar/checkout', appBase)).toBe(true);
    expect(shouldOpenExternally('mailto:soporte@huellicam.com.ar', appBase)).toBe(true);
    expect(shouldOpenExternally('https://wa.me/5491100000000', appBase)).toBe(true);
  });

  it('parses valid bridge messages and ignores malformed or unknown payloads', () => {
    expect(parseWebViewBridgeMessage('{"type":"wakelock:acquire"}')).toEqual({
      type: 'wakelock:acquire',
    });
    expect(
      parseWebViewBridgeMessage(
        JSON.stringify({
          type: 'auth:session',
          token: 'jwt-1',
          user: { id: 'u1', email: 'a@b.com', firstName: 'Ana', lastName: 'R', role: 'CLIENT' },
        })
      )
    ).toEqual({
      type: 'auth:session',
      token: 'jwt-1',
      user: { id: 'u1', email: 'a@b.com', firstName: 'Ana', lastName: 'R', role: 'CLIENT' },
    });
    expect(parseWebViewBridgeMessage('{"type":"auth:session","token":"","user":{}}')).toBeNull();
    expect(parseWebViewBridgeMessage('{"type":"unknown"}')).toBeNull();
    expect(parseWebViewBridgeMessage('not-json')).toBeNull();
  });

  it('generates safe native navigation injection script', () => {
    const script = buildNativeNavigateScript('/prescriptions/rx-1');
    expect(script).toContain('huellicam:navigate');
    expect(script).toContain('/prescriptions/rx-1');
    expect(script.endsWith('true;')).toBe(true);
  });
});
