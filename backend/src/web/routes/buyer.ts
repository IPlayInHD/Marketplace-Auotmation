import type { FastifyPluginAsync } from 'fastify';

// The public buyer route tree (ARCH-002, ARCH-003). Separate plugin scope from the seller tree.
// It declares no route in this slice: no buyer page is reachable, publicly or otherwise (D-18
// private-alpha boundaries). When Slice 2 adds the preview and the code gate, every control of
// security/PUBLIC_ACCESS_SECURITY.md §3 to §7 lives here.
export const buyerRouteTree: FastifyPluginAsync = async () => {
  // Intentionally empty.
};
