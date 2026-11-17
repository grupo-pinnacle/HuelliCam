import React from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../theme/tokens';

interface OfflineScreenProps {
  onRetry: () => void;
}

export function OfflineScreen({ onRetry }: OfflineScreenProps) {
  return (
    <View style={styles.container} testID="offline-screen">
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <Ionicons name="cloud-offline-outline" size={34} color={colors.primary} />
        </View>
        <Text style={styles.title}>Sin conexión a internet</Text>
        <Text style={styles.body}>
          Verificá tu conexión Wi-Fi o datos móviles. La app volverá a cargar automáticamente apenas recuperes señal.
        </Text>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={onRetry}
          activeOpacity={0.85}
          testID="offline-retry-button"
        >
          <Ionicons name="refresh" size={18} color="#FFFFFF" />
          <Text style={styles.primaryBtnText}>Reintentar conexión</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

interface WebViewErrorScreenProps {
  title: string;
  message: string;
  hint?: string | null;
  onRetry?: () => void;
}

export function WebViewErrorScreen({
  title,
  message,
  hint,
  onRetry,
}: WebViewErrorScreenProps) {
  return (
    <View style={styles.container} testID="webview-error-screen">
      <View style={styles.card}>
        <View style={[styles.iconCircle, styles.iconCircleDanger]}>
          <Ionicons name="alert-circle-outline" size={34} color={colors.danger} />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{message}</Text>
        {hint ? (
          <View style={styles.hintBox}>
            <Text style={styles.hintText}>{hint}</Text>
          </View>
        ) : null}
        {onRetry ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={onRetry}
            activeOpacity={0.85}
            testID="error-retry-button"
          >
            <Ionicons name="refresh" size={18} color="#FFFFFF" />
            <Text style={styles.primaryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

export function ShellLoadingOverlay() {
  return (
    <View style={styles.loadingOverlay} testID="shell-loading-overlay">
      <Image
        source={require('../../assets/icon.png')}
        style={styles.brandLogo}
        resizeMode="contain"
      />
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.loadingText}>Cargando Huellicam…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.canvas,
    padding: spacing.xxl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.xl,
    padding: spacing.xxl,
    alignItems: 'center',
  },
  iconCircle: {
    width: 68,
    height: 68,
    borderRadius: radius.full,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  iconCircleDanger: {
    backgroundColor: colors.dangerTint,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  body: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: spacing.lg,
  },
  hintBox: {
    width: '100%',
    backgroundColor: colors.sand,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  hintText: {
    fontSize: 12,
    color: colors.body,
    lineHeight: 18,
    textAlign: 'center',
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    width: '100%',
    backgroundColor: colors.primary,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.full,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    backgroundColor: colors.canvas,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
  },
  brandLogo: {
    width: 88,
    height: 88,
    borderRadius: 20,
    marginBottom: spacing.sm,
  },
  loadingText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.muted,
  },
});
