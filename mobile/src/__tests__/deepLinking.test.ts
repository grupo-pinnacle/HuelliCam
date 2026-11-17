import {
  APP_SCHEME,
  buildDeepLinkHref,
  parseDeepLink,
  resolveDeepLinkHref,
  resolveNotificationHref,
} from '../lib/deepLinks';

/**
 * Exercises the real production mapper in `src/lib/deepLinks.ts`. The previous
 * version of this file re-implemented the routing inside the `it()` bodies and
 * asserted on its own local `jest.fn()`, so it passed no matter what the app did.
 */
describe('deep link URL -> route mapping', () => {
  it('exposes the scheme declared in app.json', () => {
    expect(APP_SCHEME).toBe('huellicam');
  });

  it('routes a call link to the call screen', () => {
    expect(resolveDeepLinkHref('huellicam://call/cons-100')).toBe('/(app)/call/cons-100');
  });

  it('routes a consultation link to the consultation detail screen', () => {
    expect(resolveDeepLinkHref('huellicam://consultation/cons-200')).toBe(
      '/(app)/consultation/cons-200'
    );
  });

  it('routes a prescription link to the prescription screen', () => {
    expect(resolveDeepLinkHref('huellicam://prescriptions/rx-7')).toBe('/(app)/prescriptions/rx-7');
  });

  it('uses the param name each screen file actually declares', () => {
    // consultation/[id].tsx reads `id`, not `consultationId`.
    expect(parseDeepLink('huellicam://consultation/cons-1')).toEqual({
      screen: 'consultation',
      param: 'id',
      id: 'cons-1',
    });

    // prescriptions/[id].tsx also reads `id`.
    expect(parseDeepLink('huellicam://prescriptions/rx-1')).toEqual({
      screen: 'prescriptions',
      param: 'id',
      id: 'rx-1',
    });

    // call/[consultationId].tsx reads `consultationId`.
    expect(parseDeepLink('huellicam://call/cons-1')).toEqual({
      screen: 'call',
      param: 'consultationId',
      id: 'cons-1',
    });
  });

  it('accepts the three-slash native form emitted by some Android launchers', () => {
    expect(resolveDeepLinkHref('huellicam:///call/cons-100')).toBe('/(app)/call/cons-100');
  });

  it('ignores a query string and a fragment', () => {
    expect(resolveDeepLinkHref('huellicam://call/cons-100?from=push#top')).toBe(
      '/(app)/call/cons-100'
    );
  });

  it('tolerates surrounding whitespace and a trailing slash', () => {
    expect(resolveDeepLinkHref('  huellicam://call/cons-100/  ')).toBe('/(app)/call/cons-100');
  });

  it('matches the scheme case-insensitively, as custom schemes are case-insensitive', () => {
    expect(resolveDeepLinkHref('Huellicam://call/cons-100')).toBe('/(app)/call/cons-100');
  });

  it('decodes a percent-encoded id', () => {
    expect(resolveDeepLinkHref('huellicam://call/cons%20100')).toBe('/(app)/call/cons%20100');
  });

  it('re-encodes a decoded separator so an id cannot inject an extra path segment', () => {
    // `%2F` decodes to `/` during parsing; the href must not gain a segment.
    const href = resolveDeepLinkHref('huellicam://call/a%2Fb');
    expect(href).toBe('/(app)/call/a%2Fb');
    expect(href?.split('/')).toHaveLength(4);
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

  it('builds an href from a target directly', () => {
    expect(
      buildDeepLinkHref({ screen: 'chat', param: 'consultationId', id: 'cons-9' })
    ).toBe('/(app)/chat/cons-9');
  });
});

describe('push notification payload -> route mapping', () => {
  it('routes CALL_INCOMING to the call screen', () => {
    expect(resolveNotificationHref({ type: 'CALL_INCOMING', consultationId: 'cons-100' })).toBe(
      '/(app)/call/cons-100'
    );
  });

  it('routes MESSAGE_NEW to the consultation detail screen', () => {
    expect(resolveNotificationHref({ type: 'MESSAGE_NEW', consultationId: 'cons-200' })).toBe(
      '/(app)/consultation/cons-200'
    );
  });

  it('routes PRESCRIPTION_NEW to the prescription screen', () => {
    expect(resolveNotificationHref({ type: 'PRESCRIPTION_NEW', prescriptionId: 'rx-7' })).toBe(
      '/(app)/prescriptions/rx-7'
    );
  });

  it('accepts the generic `id` key for prescriptions', () => {
    expect(resolveNotificationHref({ type: 'PRESCRIPTION_NEW', id: 'rx-8' })).toBe(
      '/(app)/prescriptions/rx-8'
    );
  });

  it('ignores a SYSTEM notification, which addresses no screen', () => {
    expect(resolveNotificationHref({ type: 'SYSTEM', consultationId: 'cons-1' })).toBeNull();
  });

  it('ignores a known type with no usable id', () => {
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
  ])('returns null for a payload that is %s', (_label, data) => {
    expect(resolveNotificationHref(data)).toBeNull();
  });
});
