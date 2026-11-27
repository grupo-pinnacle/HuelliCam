# Routes

## Overview
React Router access-control guard component for Huellicam protected pages and role-restricted dashboards.

## Interface
- `[ProtectedRoute.tsx:ProtectedRoute]` - React component accepting optional `allowedRoles?: Role[]` and rendering `<Outlet />` for authorized users.
- `[ProtectedRoute.tsx:default]` - Default export of `ProtectedRoute`.

## Invariants
- `[ProtectedRoute.tsx:ProtectedRoute]` - Renders a loading indicator while `useAuth().loading` is `true`, redirects unauthenticated users (`!user`) to `"/login"` with `replace`, redirects users whose `user.role` is excluded from `allowedRoles` to `"/"` with `replace`, and renders `<Outlet />` otherwise.

## Side Effects
- `[ProtectedRoute.tsx:ProtectedRoute]` - Performs declarative React Router navigation (`<Navigate replace />`) to `"/login"` or `"/"` when auth or role checks fail.

## Verification
- Run: `npm test -w web`
