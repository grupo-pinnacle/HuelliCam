import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { APP_SCHEME, resolveDeepLinkHref } from '../src/lib/deepLinks';
import { getActiveSessionRole } from '../src/services/notifications.service';
import { colors, radius, spacing } from '../src/theme/tokens';

/**
 * Catch-all screen for unmatched `huellicam://` URLs. If the attempted path
 * resolves to a valid WebView deep link (e.g., cold-start `huellicam://call/123`),
 * redirect cleanly to `/` with the target path.
 */
export default function NotFoundScreen() {
  const router = useRouter();
  const attempted = usePathname();

  const resolvedWebPath = useMemo(() => {
    if (!attempted || attempted === '/') return null;
    const clean = attempted.replace(/^\/+/, '');
    return resolveDeepLinkHref(`${APP_SCHEME}://${clean}`, getActiveSessionRole());
  }, [attempted]);

  useEffect(() => {
    if (resolvedWebPath) {
      router.replace({ pathname: '/', params: { path: resolvedWebPath } });
    }
  }, [resolvedWebPath, router]);

  if (resolvedWebPath) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container} testID="not-found-screen">
      <Text style={styles.title}>Enlace no reconocido</Text>
      <Text style={styles.body}>
        Huellicam no puede abrir esta dirección dentro de la aplicación.
      </Text>
      {attempted && attempted !== '/' ? (
        <View style={styles.linkBox} testID="not-found-url">
          <Text style={styles.linkText}>{attempted}</Text>
        </View>
      ) : null}
      <TouchableOpacity
        style={styles.button}
        onPress={() => router.replace('/')}
        testID="not-found-home-button"
      >
        <Text style={styles.buttonText}>Ir al inicio</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.canvas,
    padding: spacing.xl,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  body: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: spacing.lg,
    lineHeight: 20,
  },
  linkBox: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  linkText: { fontSize: 13, color: colors.body },
  button: {
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.full,
  },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
});
