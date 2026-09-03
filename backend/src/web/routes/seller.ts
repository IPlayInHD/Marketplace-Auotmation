import type { FastifyPluginAsync } from 'fastify';

// The authenticated seller route tree (ARCH-002). It has its own plugin scope and middleware stack,
// separate from the buyer tree. It declares no route in this slice: seller routes wait on the
// authentication decision (Q-12, D-17 follow-up 8), and authorization is deny-by-default
// (AUTH-222), so an undeclared route does not exist.
export const sellerRouteTree: FastifyPluginAsync = async () => {
  // Intentionally empty.
};
