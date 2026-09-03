// Module 2 — Seller Accounts (ARCH §3). Owns app.seller: the tenant boundary (DM-01).
// No credentials, no sessions, no sign-up: identity and authentication are Module 1 and wait on
// Q-12. In the private alpha every seller is a synthetic, founder-controlled identity (D-18).
export { createSeller, getSeller, type SellerRecord } from './service.ts';
