import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Linking,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import { useLocalSearchParams, useRouter } from 'expo-router';
import NetInfo from '@react-native-community/netinfo';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Print from 'expo-print';
import {
  ShellLoadingOverlay,
  OfflineScreen,
  WebViewErrorScreen,
} from '../src/components/ShellFallbackScreens';
import { resolveDeepLinkHref } from '../src/lib/deepLinks';
import {
  buildNativeNavigateScript,
  DEFAULT_WEB_ENTRY_PATH,
  HARDENED_WEBVIEW_CONFIG,
  handleContentProcessTermination,
  isCallRouteUrl,
  isLoopbackUrl,
  parseWebViewBridgeMessage,
  resolveWebAppUrl,
  resolveWebBaseUrlConfig,
  shouldOpenExternally,
} from '../src/lib/webviewBridge';
import notificationsService, {
  getActiveSessionRole,
} from '../src/services/notifications.service';
import { colors } from '../src/theme/tokens';

const CALL_WAKELOCK_TAG = 'huellicam-call';
type WebViewExtraProps = unknown;
type ShellWebViewInstance = WebView<WebViewExtraProps>;

export default function WebViewShellScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ path?: string | string[] }>();
  const initialRouteParam = useMemo(() => {
    const raw = Array.isArray(params.path) ? params.path[0] : params.path;
    return raw && raw.startsWith('/') ? raw : DEFAULT_WEB_ENTRY_PATH;
  }, [params.path]);

  const webConfig = useMemo(
    () => resolveWebBaseUrlConfig(process.env.EXPO_PUBLIC_WEB_URL, __DEV__),
    []
  );

  const webviewRef = useRef<ShellWebViewInstance>(null);
  const canGoBackRef = useRef(false);
  const webLoadedRef = useRef(false);
  const pendingNavPathRef = useRef<string | null>(null);
  const previousOfflineRef = useRef(false);
  const wakeLockActiveRef = useRef(false);
  const permissionPromptedForCallRef = useRef(false);

  const [initialUri, setInitialUri] = useState<string | null>(() =>
    webConfig.url ? resolveWebAppUrl(webConfig.url, initialRouteParam) : null
  );
  const [isLoaded, setIsLoaded] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [isInCall, setIsInCall] = useState(false);
  const [webViewError, setWebViewError] = useState<string | null>(null);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const acquireCallWakeLock = useCallback(() => {
    if (wakeLockActiveRef.current) return;
    wakeLockActiveRef.current = true;
    void activateKeepAwakeAsync(CALL_WAKELOCK_TAG).catch(() => {});
  }, []);

  const releaseCallWakeLock = useCallback(() => {
    if (!wakeLockActiveRef.current) return;
    wakeLockActiveRef.current = false;
    try {
      void deactivateKeepAwake(CALL_WAKELOCK_TAG);
    } catch {
      // Ignore cleanup errors
    }
  }, []);

  useEffect(() => {
    return () => {
      releaseCallWakeLock();
    };
  }, [releaseCallWakeLock]);

  const navigateInsideWebView = useCallback(
    (targetPath: string) => {
      if (!webConfig.url) return;
      if (webLoadedRef.current && webviewRef.current) {
        webviewRef.current.injectJavaScript(buildNativeNavigateScript(targetPath));
      } else {
        pendingNavPathRef.current = targetPath;
        setInitialUri(resolveWebAppUrl(webConfig.url, targetPath));
      }
    },
    [webConfig.url]
  );

  // When search param changes (e.g. cold-start deep link redirect from +not-found)
  useEffect(() => {
    if (params.path) {
      navigateInsideWebView(initialRouteParam);
    }
  }, [params.path, initialRouteParam, navigateInsideWebView]);

  // Network reachability listener with automatic recovery when connection returns
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const disconnected =
        state.isConnected === false || state.isInternetReachable === false;
      setIsOffline(disconnected);

      if (previousOfflineRef.current && !disconnected) {
        setWebViewError(null);
        webviewRef.current?.reload();
      }
      previousOfflineRef.current = disconnected;
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Android hardware Back button navigates WebView history before closing app
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!isOffline && !webViewError && canGoBackRef.current && webviewRef.current) {
        webviewRef.current.goBack();
        return true;
      }
      return false;
    });

    return () => {
      subscription.remove();
    };
  }, [isOffline, webViewError]);

  // Incoming deep links (`huellicam://...`)
  useEffect(() => {
    const handleIncomingUrl = (url: string | null) => {
      if (!url) return;
      const resolved = resolveDeepLinkHref(url, getActiveSessionRole());
      if (resolved) {
        navigateInsideWebView(resolved);
      } else if (url.toLowerCase().startsWith('huellicam://')) {
        router.replace('/+not-found');
      }
    };

    void Linking.getInitialURL()
      .then(handleIncomingUrl)
      .catch(() => {});

    const sub = Linking.addEventListener('url', ({ url }) => {
      handleIncomingUrl(url);
    });

    return () => {
      sub.remove();
    };
  }, [navigateInsideWebView, router]);

  // Push notification tap listener (cold-start + background/foreground)
  useEffect(() => {
    const teardown = notificationsService.setupNotificationListeners((href) => {
      navigateInsideWebView(href);
    });
    return teardown;
  }, [navigateInsideWebView]);

  const ensureCallMediaPermissions = useCallback(async () => {
    const needsCam = !cameraPermission?.granted;
    const needsMic = !micPermission?.granted;
    if (!needsCam && !needsMic) return;

    await Promise.all([
      needsCam ? requestCameraPermission() : Promise.resolve(null),
      needsMic ? requestMicPermission() : Promise.resolve(null),
    ]);
  }, [
    cameraPermission?.granted,
    micPermission?.granted,
    requestCameraPermission,
    requestMicPermission,
  ]);

  const handleNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      canGoBackRef.current = Boolean(navState.canGoBack);
      const inCallNow = isCallRouteUrl(navState.url || '');
      setIsInCall(inCallNow);

      if (inCallNow) {
        if (!permissionPromptedForCallRef.current) {
          permissionPromptedForCallRef.current = true;
          void ensureCallMediaPermissions();
        }
      } else {
        permissionPromptedForCallRef.current = false;
        releaseCallWakeLock();
      }
    },
    [ensureCallMediaPermissions, releaseCallWakeLock]
  );

  const handlePrintRequest = useCallback(
    async (title: string, url: string, html?: string) => {
      try {
        if (html) {
          await Print.printAsync({ html });
          return;
        }
      } catch {
        // Fallback to system share sheet when native Print fails
      }

      try {
        await Share.share({
          title,
          message: url ? `${title}\n${url}` : title,
          url: url || undefined,
        });
      } catch {
        // Ignore user cancel
      }
    },
    []
  );

  const handleWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const msg = parseWebViewBridgeMessage(event.nativeEvent.data);
      if (!msg) return;

      switch (msg.type) {
        case 'page:ready': {
          webLoadedRef.current = true;
          setIsLoaded(true);
          if (pendingNavPathRef.current && webviewRef.current) {
            const target = pendingNavPathRef.current;
            pendingNavPathRef.current = null;
            webviewRef.current.injectJavaScript(buildNativeNavigateScript(target));
          }
          break;
        }
        case 'auth:session': {
          void notificationsService.syncSessionWithBackend(msg.token, msg.user);
          break;
        }
        case 'auth:logout': {
          void notificationsService.syncSessionWithBackend(null);
          break;
        }
        case 'wakelock:acquire': {
          acquireCallWakeLock();
          break;
        }
        case 'wakelock:release':
        case 'call:ended': {
          releaseCallWakeLock();
          break;
        }
        case 'print:request': {
          void handlePrintRequest(msg.title, msg.url, msg.html);
          break;
        }
        case 'external:open': {
          void Linking.openURL(msg.url).catch(() => {});
          break;
        }
      }
    },
    [acquireCallWakeLock, handlePrintRequest, releaseCallWakeLock]
  );

  const handleRetry = useCallback(() => {
    setWebViewError(null);
    webLoadedRef.current = false;
    setIsLoaded(false);
    webviewRef.current?.reload();
  }, []);

  if (webConfig.error || !webConfig.url || !initialUri) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <WebViewErrorScreen
          title="Configuración pendiente"
          message={webConfig.error || 'No se pudo resolver la URL de Huellicam.'}
        />
      </SafeAreaView>
    );
  }

  const activeWebBaseUrl = webConfig.url;

  if (isOffline) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <OfflineScreen onRetry={handleRetry} />
      </SafeAreaView>
    );
  }

  if (webViewError) {
    const devHint =
      __DEV__ && isLoopbackUrl(activeWebBaseUrl)
        ? 'Modo desarrollo local: verificá que `npm run dev` esté corriendo en tu PC y ejecutá `adb reverse tcp:5173 tcp:5173 && adb reverse tcp:3001 tcp:3001` por USB, o configurá tu IP LAN en EXPO_PUBLIC_WEB_URL.'
        : null;

    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <WebViewErrorScreen
          title="No pudimos conectar con Huellicam"
          message={webViewError}
          hint={devHint}
          onRetry={handleRetry}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, isInCall ? styles.callContainer : null]}
      edges={['top', 'bottom', 'left', 'right']}
    >
      <View style={styles.webviewWrap}>
        <WebView<WebViewExtraProps>
          ref={webviewRef}
          source={{ uri: initialUri }}
          onMessage={handleWebViewMessage}
          onNavigationStateChange={handleNavigationStateChange}
          onShouldStartLoadWithRequest={(request) => {
            if (shouldOpenExternally(request.url, activeWebBaseUrl)) {
              void Linking.openURL(request.url).catch(() => {});
              return false;
            }
            return true;
          }}
          onLoadEnd={() => {
            webLoadedRef.current = true;
            setIsLoaded(true);
            if (pendingNavPathRef.current && webviewRef.current) {
              const target = pendingNavPathRef.current;
              pendingNavPathRef.current = null;
              webviewRef.current.injectJavaScript(buildNativeNavigateScript(target));
            }
          }}
          onError={(syntheticEvent) => {
            releaseCallWakeLock();
            setWebViewError(
              syntheticEvent.nativeEvent?.description ||
                'Ocurrió un problema al cargar la aplicación web.'
            );
          }}
          onHttpError={(syntheticEvent) => {
            if (syntheticEvent.nativeEvent.statusCode >= 500) {
              releaseCallWakeLock();
              setWebViewError(
                `El servidor respondió con código ${syntheticEvent.nativeEvent.statusCode}.`
              );
            }
          }}
          onContentProcessDidTerminate={(syntheticEvent) => {
            handleContentProcessTermination(syntheticEvent, webviewRef.current);
          }}
          domStorageEnabled={HARDENED_WEBVIEW_CONFIG.domStorageEnabled}
          javaScriptEnabled={HARDENED_WEBVIEW_CONFIG.javaScriptEnabled}
          sharedCookiesEnabled={HARDENED_WEBVIEW_CONFIG.sharedCookiesEnabled}
          thirdPartyCookiesEnabled={HARDENED_WEBVIEW_CONFIG.thirdPartyCookiesEnabled}
          allowsInlineMediaPlayback={HARDENED_WEBVIEW_CONFIG.allowsInlineMediaPlayback}
          mediaPlaybackRequiresUserAction={
            HARDENED_WEBVIEW_CONFIG.mediaPlaybackRequiresUserAction
          }
          allowFileAccess={HARDENED_WEBVIEW_CONFIG.allowFileAccess}
          mediaCapturePermissionGrantType={
            HARDENED_WEBVIEW_CONFIG.mediaCapturePermissionGrantType
          }
          originWhitelist={[...HARDENED_WEBVIEW_CONFIG.originWhitelist]}
          setSupportMultipleWindows={HARDENED_WEBVIEW_CONFIG.setSupportMultipleWindows}
          pullToRefreshEnabled={HARDENED_WEBVIEW_CONFIG.pullToRefreshEnabled}
          bounces={HARDENED_WEBVIEW_CONFIG.bounces}
          allowsFullscreenVideo
          allowsBackForwardNavigationGestures
          mixedContentMode="compatibility"
          style={styles.webview}
        />
        {!isLoaded && <ShellLoadingOverlay />}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  callContainer: {
    backgroundColor: colors.callDark,
  },
  webviewWrap: {
    flex: 1,
    position: 'relative',
  },
  webview: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
});
