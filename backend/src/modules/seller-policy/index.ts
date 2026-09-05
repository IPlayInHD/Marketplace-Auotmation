// Seller policy versions: the deterministic rule set of DOMAIN_MODEL.md (SellerPolicy /
// SellerPolicyVersion), versioned and immutable (DM-06). The minimum price lives only here and is
// protected (P3, D-04): it never appears in a buyer payload, a log or model context.
// The pure decision engine (Module 11) is not part of this slice.
export {
  PolicyVersionInputSchema,
  createPolicyVersion,
  getPolicyVersion,
  type PolicyVersionInput,
  type PolicyVersionRecord,
} from './service.ts';
