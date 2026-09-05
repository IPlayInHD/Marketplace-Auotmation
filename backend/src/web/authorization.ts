// AUTH-222: authorization is deny-by-default. Every route registered under a protected prefix
// must carry an explicit declaration in its route config; a route without one fails the build:
// the onRoute hook throws, registration fails, and so does startup. The declaration names the
// policy the web layer enforces and describes, for the route inventory, who may call the route,
// on what, under which tenant source, with which idempotency, audit and failure behaviour.

export type AuthorizationPolicy = 'unauthenticated-sign-in' | 'seller-session';

/** The canonical AUTH-222 declaration of one route: every field is required and non-empty. */
export interface RouteDeclaration {
  actor: 'anonymous' | 'seller';
  resource: string;
  action: string;
  authentication: 'none' | 'seller-session';
  /** The rule that decides whether the actor may act on the resource. */
  authorization: string;
  /** Where the tenant context comes from; never a request parameter, header or body field. */
  tenantSource: 'none' | 'session';
  classification: 'read-only' | 'consequential' | 'one-time-secret' | 'naturally-idempotent';
  idempotency: string;
  audit: string;
  failure: string;
}

export const ROUTE_DECLARATION_FIELDS = [
  'actor',
  'resource',
  'action',
  'authentication',
  'authorization',
  'tenantSource',
  'classification',
  'idempotency',
  'audit',
  'failure',
] as const satisfies readonly (keyof RouteDeclaration)[];

declare module 'fastify' {
  interface FastifyContextConfig {
    authorization?: AuthorizationPolicy;
    declaration?: RouteDeclaration;
  }
}

export interface DeclaredRoute {
  method: string;
  url: string;
  authorization: AuthorizationPolicy;
  declaration: RouteDeclaration;
}

interface RouteLike {
  method: string | readonly string[];
  url: string;
  config?: { authorization?: AuthorizationPolicy; declaration?: RouteDeclaration } | undefined;
}

interface HookHost {
  addHook(name: 'onRoute', hook: (route: RouteLike) => void): unknown;
}

const INVENTORY = new WeakMap<object, DeclaredRoute[]>();

function isComplete(declaration: RouteDeclaration | undefined): declaration is RouteDeclaration {
  return (
    declaration !== undefined &&
    ROUTE_DECLARATION_FIELDS.every((field) => {
      const value = declaration[field];
      return typeof value === 'string' && value.trim().length > 0;
    })
  );
}

export function enforceRouteDeclarations(app: HookHost, protectedPrefix: string): void {
  const inventory: DeclaredRoute[] = [];
  INVENTORY.set(app, inventory);
  app.addHook('onRoute', (route) => {
    const methods: readonly string[] = typeof route.method === 'string' ? [route.method] : route.method;
    const policy = route.config?.authorization;
    const declaration = route.config?.declaration;
    const complete = policy !== undefined && isComplete(declaration);
    for (const method of methods) {
      if (method === 'HEAD') {
        // Fastify derives a HEAD route from every GET with the same config; it is guarded, not listed.
        if (route.url.startsWith(protectedPrefix) && !complete) {
          throw new Error(
            `AUTH-222: HEAD ${route.url} has no complete authorization declaration; the route is refused`,
          );
        }
        continue;
      }
      if (route.url.startsWith(protectedPrefix)) {
        if (!complete) {
          throw new Error(
            `AUTH-222: ${method} ${route.url} has no complete authorization declaration; the route is refused`,
          );
        }
        inventory.push({ method, url: route.url, authorization: policy, declaration });
      } else if (complete) {
        inventory.push({ method, url: route.url, authorization: policy, declaration });
      }
    }
  });
}

/** Every declared route, for the build-time inventory check (AUTH-222). */
export function declaredRoutes(app: object): readonly DeclaredRoute[] {
  return INVENTORY.get(app) ?? [];
}
