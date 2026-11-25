import React, { useEffect, Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import ErrorBoundary from './components/common/ErrorBoundary';
import OfflineBanner from './components/common/OfflineBanner';
import CookieConsentBanner from './components/common/CookieConsentBanner';
import SessionTerminatedModal from './components/common/SessionTerminatedModal';
import { ScopedStyle } from './components/common/ScopedStyle';
import { isReactNativeWebView, requestMobileExternalOpen } from './lib/mobileBridge';

export { ScopedStyle };

const Landing = lazy(() => import('./pages/Landing'));
const AuthExperience = lazy(() => import('./pages/AuthExperience'));
const GlobalCallListener = lazy(() => import('./components/call/GlobalCallListener'));
const ClientApp = lazy(() => import('./pages/ClientApp'));
const VetApp = lazy(() => import('./vet/VetApp'));
const CallRoom = lazy(() => import('./vet/CallRoom'));

// Compliance & Extra Pages
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const TermsConditions = lazy(() => import('./pages/TermsConditions'));
const CookiePolicy = lazy(() => import('./pages/CookiePolicy'));
const RefundPolicy = lazy(() => import('./pages/RefundPolicy'));
const PrescriptionView = lazy(() => import('./pages/PrescriptionView'));
const AdminApp = lazy(() => import('./pages/AdminApp'));
const NotFound = lazy(() => import('./pages/NotFound'));

const AuthenticatedCallListener: React.FC = () => {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <Suspense fallback={null}>
      <GlobalCallListener />
    </Suspense>
  );
};

const LandingWrapper: React.FC = () => <Landing />;

const AuthWrapper: React.FC = () => <AuthExperience />;

const ClientWrapper: React.FC = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login', { replace: true });
    } else if (!loading && user?.role === 'VET') {
      navigate('/vet/dashboard', { replace: true });
    } else if (!loading && user?.role === 'ADMIN') {
      navigate('/admin/dashboard', { replace: true });
    }
  }, [user, loading, navigate]);

  if (!loading && (!user || user?.role === 'VET' || user?.role === 'ADMIN')) {
    return <div className="route-loading" role="status">Redirigiendo…</div>;
  }

  return <ClientApp />;
};

const VetWrapper: React.FC = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login', { replace: true });
    } else if (!loading && user?.role === 'CLIENT') {
      navigate('/client/dashboard', { replace: true });
    } else if (!loading && user?.role === 'ADMIN') {
      navigate('/admin/dashboard', { replace: true });
    }
  }, [user, loading, navigate]);

  if (!loading && (!user || user?.role !== 'VET')) {
    return <div className="route-loading" role="status">Redirigiendo…</div>;
  }

  return <VetApp path={location.pathname} />;
};

const CallWrapper: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  return <CallRoom id={id || 'milo'} />;
};

const MobileNavigationBridge: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const handleNativeNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string }>).detail;
      const targetPath = detail?.path?.trim();
      if (!targetPath || !targetPath.startsWith('/')) return;

      navigate(targetPath);
      window.dispatchEvent(new PopStateEvent('popstate'));
    };

    window.addEventListener('huellicam:navigate', handleNativeNavigate);
    return () => {
      window.removeEventListener('huellicam:navigate', handleNativeNavigate);
    };
  }, [navigate]);

  return null;
};

const AdminMobileRestriction: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <main
      data-testid="admin-mobile-restriction"
      className="min-h-[100dvh] bg-[#fffbef] text-[#183c3a] flex items-center justify-center p-6 font-['Manrope',sans-serif]"
    >
      <section className="w-full max-w-md bg-white border border-[#e4dfd2] rounded-3xl p-7 shadow-sm text-center space-y-4">
        <img
          src="/assets/huellicam-mark.png"
          alt="Huellicam"
          className="w-14 h-12 mx-auto object-contain"
        />
        <span className="inline-block text-[11px] font-extrabold uppercase tracking-wider px-3 py-1 rounded-full bg-[#d9e8e4] text-[#315f5d]">
          Acceso exclusivo escritorio
        </span>
        <h1 className="text-xl font-extrabold text-[#183c3a]">
          Panel de administración web
        </h1>
        <p className="text-sm text-[#607674] leading-relaxed">
          Hola{user?.firstName ? `, ${user.firstName}` : ''}. La app móvil está optimizada para Tutores y Veterinarios. Para gestionar matrículas, métricas y auditoría, ingresá desde una computadora.
        </p>
        <div className="pt-2 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="w-full py-3 px-5 rounded-full bg-[#315f5d] hover:bg-[#183c3a] text-white text-sm font-bold transition-colors cursor-pointer"
          >
            Cerrar sesión y cambiar de cuenta
          </button>
          <button
            type="button"
            onClick={() => requestMobileExternalOpen(window.location.href)}
            className="w-full py-3 px-5 rounded-full border border-[#e4dfd2] bg-[#fffbef] hover:bg-[#f2eddd] text-[#183c3a] text-sm font-bold transition-colors cursor-pointer"
          >
            Abrir consola en el navegador
          </button>
        </div>
      </section>
    </main>
  );
};

const AdminWrapper: React.FC = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && (!user || user.role !== 'ADMIN')) {
      navigate('/login', { replace: true });
    }
  }, [user, loading, navigate]);

  if (!loading && (!user || user.role !== 'ADMIN')) {
    return <div className="route-loading" role="status">Acceso restringido. Redirigiendo a inicio de sesión…</div>;
  }

  if (!loading && user?.role === 'ADMIN' && isReactNativeWebView()) {
    return <AdminMobileRestriction />;
  }

  return <AdminApp />;
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  },
});

export const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <SocketProvider>
            <BrowserRouter>
              <MobileNavigationBridge />
              <OfflineBanner />
              <AuthenticatedCallListener />
              <SessionTerminatedModal />
              {!isReactNativeWebView() && <CookieConsentBanner />}
              <Suspense fallback={<div className="route-loading" role="status">Cargando...</div>}>
                <Routes>
                  {/* 1. Landing & Inicio */}
                  <Route path="/" element={<LandingWrapper />} />

                  {/* 2. Autenticación (Login, Registro Tutores/Vets, Olvidé Contraseña) */}
                  <Route path="/login" element={<AuthWrapper />} />
                  <Route path="/register/*" element={<AuthWrapper />} />
                  <Route path="/register" element={<AuthWrapper />} />
                  <Route path="/forgot-password" element={<AuthWrapper />} />

                  {/* 3. Portal de Tutores (Cliente) */}
                  <Route path="/client/*" element={<ClientWrapper />} />
                  <Route path="/client" element={<ClientWrapper />} />

                  {/* 4. Portal Profesional (Veterinario) */}
                  <Route path="/vet/*" element={<VetWrapper />} />
                  <Route path="/vet" element={<VetWrapper />} />

                  {/* 5. Videoconsultas en vivo */}
                  <Route path="/call/:id" element={<CallWrapper />} />

                  {/* 6. Panel de Administración (Super Admin CRUD) */}
                  <Route path="/admin/*" element={<AdminWrapper />} />
                  <Route path="/admin" element={<AdminWrapper />} />

                  {/* Recetas y verificaciones SENASA */}
                  <Route path="/prescriptions/:id" element={<PrescriptionView />} />
                  <Route path="/verify-rx" element={<PrescriptionView />} />

                  {/* Páginas Legales */}
                  <Route path="/privacy" element={<PrivacyPolicy />} />
                  <Route path="/terms" element={<TermsConditions />} />
                  <Route path="/cookies" element={<CookiePolicy />} />
                  <Route path="/refunds" element={<RefundPolicy />} />

                  {/* Fallback 404: Página no encontrada */}
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </BrowserRouter>
          </SocketProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
