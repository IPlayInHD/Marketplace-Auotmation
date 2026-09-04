// Module 22 — Marketplace Abstractions (ARCH §3, ARCH-005). At MVP: copy formatting only. It makes
// no network call to any marketplace (INT-002) and stores nothing. Channel labels and per-channel
// codes (BUYER-025) are not part of this slice.
export {
  MARKETPLACE_LINK_NOTICE,
  buildMarketplaceCopyBlock,
  formatMoney,
  type CopyBlockInput,
  type MarketplaceCopyBlock,
} from './copy-block.ts';
