import {
  APP_SCHEME,
  buildDeepLinkHref,
  parseDeepLink,
  resolveDeepLinkHref,
  resolveNotificationHref,
} from '../lib/deepLinks';

describe('deep link URL -> WebView SPA route mapping', () => {
  it('exposes the scheme declared in app.json', () => {
    expect(APP_SCHEME).toBe('huellicam');
  });

  it('routes a call link to /call/:id', () => {
    expect(resolveDeepLinkHref('huellicam://call/cons-100')).toBe('/call/cons-100');
  });

  it('routes consultation links according to active user role (CLIENT vs VET)', () => {
    expect(resolveDeepLinkHref('huellicam://consultation/cons-200', 'CLIENT')).toBe(
      '/client/consultations/cons-200'
    );
    expect(resolveDeepLinkHref('huellicam://consultation/cons-200', 'VET')).toBe(
      '/vet/consultations/cons-200'
    );
  });

  it('routes a prescription link to /prescriptions/:id', () => {
    expect(resolveDeepLinkHref('huellicam://prescriptions/rx-7')).toBe('/prescriptions/rx-7');
  });

  it('uses explicit screen targets during parsing', () => {
    expect(parseDeepLink('huellicam://consultation/cons-1')).toEqual({
      screen: 'consultation',
      param: 'id',
      id: 'cons-1',
    });

    expect(parseDeepLink('huellicam://prescriptions/rx-1')).toEqual({
      screen: 'prescriptions',
      param: 'id',
      id: 'rx-1',
    });

    expect(parseDeepLink('huellicam://call/cons-1')).toEqual({
      screen: 'call',
      param: 'consultationId',
      id: 'cons-1',
    });
  });

  it('accepts three-slash native URIs emitted by Android launchers', () => {
    expect(resolveDeepLinkHref('huellicam:///call/cons-100')).toBe('/call/cons-100');
  });

  it('ignores query strings and fragments', () => {
    expect(resolveDeepLinkHref('huellicam://call/cons-100?from=push#top')).toBe('/call/cons-100');
  });

  it('tolerates surrounding whitespace and trailing slashes', () => {
    expect(resolveDeepLinkHref('  huellicam://call/cons-100/  ')).toBe('/call/cons-100');
  });

  it('matches scheme case-insensitively', () => {
    expect(resolveDeepLinkHref('Huellicam://call/cons-100')).toBe('/call/cons-100');
  });

  it('decodes and safely re-encodes path segments', () => {
    expect(resolveDeepLinkHref('huellicam://call/cons%20100')).toBe('/call/cons%20100');
    const href = resolveDeepLinkHref('huellicam://call/a%2Fb');
    expect(href).toBe('/call/a%2Fb');
    expect(href?.split('/')).toHaveLength(3);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a missing scheme', 'call/cons-100'],
    ['a foreign scheme', 'otherapp://call/cons-100'],
    ['an https universal link', 'https://huellicam.com.ar/call/cons-100'],
    ['an unknown screen', 'huellicam://billing/cons-100'],
    ['a missing id', 'huellicam://call'],
    ['a blank id', 'huellicam://call/%20'],
    ['an over-deep path', 'huellicam://call/cons-100/extra'],
    ['malformed percent-encoding', 'huellicam://call/%E0%A4%A'],
  ])('returns null for %s so the link falls through to +not-found', (_label, url) => {
    expect(resolveDeepLinkHref(url)).toBeNull();
  });

  it('maps chat targets cleanly by role', () => {
    expect(
      buildDeepLinkHref({ screen: 'chat', param: 'consultationId', id: 'cons-9' }, 'CLIENT')
    ).toBe('/client/messages');
    expect(
      buildDeepLinkHref({ screen: 'chat', param: 'consultationId', id: 'cons-9' }, 'VET')
    ).toBe('/vet/messages');
  });
});

describe('push notification payload -> WebView SPA route mapping', () => {
  it('routes CALL_INCOMING to /call/:id', () => {
    expect(resolveNotificationHref({ type: 'CALL_INCOMING', consultationId: 'cons-100' })).toBe(
      '/call/cons-100'
    );
  });

  it('routes MESSAGE_NEW by user role', () => {
    expect(
      resolveNotificationHref({ type: 'MESSAGE_NEW', consultationId: 'cons-200' }, 'CLIENT')
    ).toBe('/client/consultations/cons-200');
    expect(
      resolveNotificationHref({ type: 'MESSAGE_NEW', consultationId: 'cons-200' }, 'VET')
    ).toBe('/vet/consultations/cons-200');
  });

  it('routes PRESCRIPTION_NEW to /prescriptions/:id', () => {
    expect(resolveNotificationHref({ type: 'PRESCRIPTION_NEW', prescriptionId: 'rx-7' })).toBe(
      '/prescriptions/rx-7'
    );
    expect(resolveNotificationHref({ type: 'PRESCRIPTION_NEW', id: 'rx-8' })).toBe(
      '/prescriptions/rx-8'
    );
  });

  it('ignores SYSTEM notifications and incomplete payloads', () => {
    expect(resolveNotificationHref({ type: 'SYSTEM', consultationId: 'cons-1' })).toBeNull();
    expect(resolveNotificationHref({ type: 'CALL_INCOMING' })).toBeNull();
    expect(resolveNotificationHref({ type: 'CALL_INCOMING', consultationId: '  ' })).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'CALL_INCOMING'],
    ['an array', [{ type: 'CALL_INCOMING' }]],
    ['a non-string type', { type: 42 }],
    ['an object with no type', { consultationId: 'cons-1' }],
  ])('returns null for payload that is %s', (_label, data) => {
    expect(resolveNotificationHref(data)).toBeNull();
  });
});
