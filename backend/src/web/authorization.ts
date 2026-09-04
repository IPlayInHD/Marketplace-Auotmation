// AUTH-222: authorization is deny-by-default. Every route registered under a protected prefix
// must carry an explicit declaration in its route config; a route without one fails the build:
// the onRoute hook throws, registration fails, and so does startup.

export type AuthorizationPolicy = 'unauthenticated-sign-in' | 'seller-session';

declare module 'fastify' {
  interface FastifyContextConfig {
    authorization?: AuthorizationPolicy;
  }
}

export interface DeclaredRoute {
  method: string;
  url: string;
  authorization: AuthorizationPolicy;
}

interface RouteLike {
  method: string | readonly string[];
  url: string;
  config?: { authorization?: AuthorizationPolicy } | undefined;
}

interface HookHost {
  addHook(name: 'onRoute', hook: (route: RouteLike) => void): unknown;
}

const INVENTORY = new WeakMap<object, DeclaredRoute[]>();

export function enforceRouteDeclarations(app: HookHost, protectedPrefix: string): void {
  const inventory: DeclaredRoute[] = [];
  INVENTORY.set(app, inventory);
  app.addHook('onRoute', (route) => {
    const methods: readonly string[] = typeof route.method === 'string' ? [route.method] : route.method;
    const declared = route.config?.authorization;
    for (const method of methods) {
      if (method === 'HEAD') {
        // Fastify derives a HEAD route from every GET with the same config; it is guarded, not listed.
        if (route.url.startsWith(protectedPrefix) && declared === undefined) {
          throw new Error(
            `AUTH-222: HEAD ${route.url} has no authorization declaration; the route is refused`,
          );
        }
        continue;
      }
      if (route.url.startsWith(protectedPrefix)) {
        if (declared === undefined) {
          throw new Error(
            `AUTH-222: ${method} ${route.url} has no authorization declaration; the route is refused`,
          );
        }
        inventory.push({ method, url: route.url, authorization: declared });
      } else if (declared !== undefined) {
        inventory.push({ method, url: route.url, authorization: declared });
      }
    }
  });
}

/** Every declared route, for the build-time inventory check (AUTH-222). */
export function declaredRoutes(app: object): readonly DeclaredRoute[] {
  return INVENTORY.get(app) ?? [];
}
