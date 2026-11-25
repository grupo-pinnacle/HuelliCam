const envOrigins = [
  process.env.CORS_ORIGIN,
  process.env.FRONTEND_URL,
  process.env.CLIENT_URL,
]
  .filter(Boolean)
  .flatMap((o) => (o as string).split(','))
  .map((o) => o.trim());

const defaultOrigins = [
  'https://app.huellicam.com.ar',
  'https://admin.huellicam.com.ar',
  'https://huellicam-web.vercel.app',
];

const devOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

export const allowedOrigins = Array.from(
  new Set([
    ...defaultOrigins,
    ...(process.env.NODE_ENV !== 'production' ? devOrigins : []),
    ...envOrigins,
  ])
);

export const isAllowedOrigin = (origin?: string): boolean => {
  if (!origin) return true; // Mobile clients, same-origin, curl, server-to-server
  const cleanOrigin = origin.replace(/\/$/, '');
  return allowedOrigins.includes(cleanOrigin) || allowedOrigins.includes(origin);
};

