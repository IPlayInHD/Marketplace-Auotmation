import type { BuyerSafeListing } from '../domain/projection.ts';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMinor(amountMinor: number, currency: string): string {
  // Display only. Money stays integer minor units everywhere else.
  const major = Math.trunc(amountMinor / 100);
  const minor = Math.abs(amountMinor % 100).toString().padStart(2, '0');
  return `${escapeHtml(currency)} ${major}.${minor}`;
}

/** Server-rendered buyer page. No client-side framework, no script, no external resources. */
export function renderBuyerPage(listing: BuyerSafeListing): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(listing.title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:40rem}dt{font-weight:600}</style>
</head>
<body>
<p><em>Spike demonstration page. This listing is not real.</em></p>
<h1>${escapeHtml(listing.title)}</h1>
<dl>
<dt>Asking price</dt><dd>${formatMinor(listing.askingPriceMinor, listing.currency)}</dd>
<dt>Seller</dt><dd>${escapeHtml(listing.sellerDisplayName)}</dd>
<dt>Listing</dt><dd>${escapeHtml(listing.publicId)}</dd>
</dl>
</body>
</html>
`;
}

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not available</title></head>
<body><p>This listing is not available.</p></body></html>
`;
}
