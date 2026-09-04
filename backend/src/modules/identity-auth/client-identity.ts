import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { BlockList, isIP, isIPv4 } from 'node:net';

// Trusted-proxy policy and hashed client identifiers (D-19 condition 6, SEC-043, OPS-568).
//
// The peer address of the TCP connection is the only fact the server knows. Forwarding headers
// are believed only when the peer is an explicitly configured trusted proxy, and then only the
// entries added by trusted proxies are skipped: the chain is walked from the right and the first
// address not in the trusted set is the client. Anything malformed or ambiguous fails closed.
// The client identifier is canonical (IPv4 exact, IPv6 by /64 prefix per RFC 6177) and is hashed
// with a keyed construction before it is stored or audited; the key never appears in source.

export interface TrustedProxyPolicy {
  readonly entries: readonly string[];
  isTrusted(address: string): boolean;
}

function parseCidr(entry: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } {
  const [address, prefixText] = entry.split('/');
  if (!address || isIP(address) === 0)
    throw new Error(`trusted proxy entry is not an IP address or CIDR: ${entry}`);
  const family = isIPv4(address) ? 'ipv4' : 'ipv6';
  const max = family === 'ipv4' ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max)
    throw new Error(`trusted proxy prefix is invalid: ${entry}`);
  return { address, prefix, family };
}

export function trustedProxyPolicy(entries: readonly string[]): TrustedProxyPolicy {
  const list = new BlockList();
  for (const entry of entries) {
    const { address, prefix, family } = parseCidr(entry);
    list.addSubnet(address, prefix, family);
  }
  return {
    entries,
    isTrusted: (address) => {
      const normalized = stripMappedIpv4(address);
      const kind = isIP(normalized);
      if (kind === 0) return false;
      return list.check(normalized, kind === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

/** `::ffff:203.0.113.5` is the IPv4 client, not an IPv6 one. */
function stripMappedIpv4(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m?.[1] ?? address;
}

/** Full 8-hextet expansion of an IPv6 address, lower-case, or null if it does not parse. */
export function expandIpv6(address: string): string | null {
  const mapped = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  let text = address.toLowerCase();
  if (mapped) {
    const octets = mapped[2]?.split('.').map(Number) ?? [];
    if (octets.length !== 4 || octets.some((o) => o > 255)) return null;
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${mapped[1]}${hi.toString(16)}:${lo.toString(16)}`.toLowerCase();
  }
  if (isIP(text) !== 6) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/** IPv4 exact; IPv6 by its /64 prefix; IPv4-mapped IPv6 as the IPv4 it carries. */
export function canonicalClientIdentifier(address: string): string | null {
  const plain = stripMappedIpv4(address);
  if (isIPv4(plain)) return plain;
  const expanded = expandIpv6(plain);
  if (!expanded) return null;
  return `${expanded.split(':').slice(0, 4).join(':')}::/64`;
}

export type ClientResolution =
  | { ok: true; address: string; canonical: string; viaTrustedProxy: boolean }
  | {
      ok: false;
      reason: 'no_peer' | 'malformed_peer' | 'malformed_chain' | 'ambiguous_chain' | 'conflicting_headers';
    };

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const all = Array.isArray(value) ? value : [value];
  return all.flatMap((v) => v.split(',')).map((v) => v.trim());
}

/** A `for=` node identifier of RFC 7239 or a bare X-Forwarded-For entry, reduced to an IP address or null. */
function parseNode(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end === -1) return null;
    text = text.slice(1, end);
  } else if (isIP(text) === 0) {
    // IPv4 with a port, e.g. 203.0.113.5:4711
    const m = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
    if (m?.[1]) text = m[1];
  }
  return isIP(text) === 0 ? null : text;
}

/** The `for=` parameters of every Forwarded element, in header order. */
function forwardedNodes(values: string[]): (string | null)[] {
  const nodes: (string | null)[] = [];
  for (const element of values) {
    for (const pair of element.split(';')) {
      const [key, ...rest] = pair.split('=');
      if (key?.trim().toLowerCase() !== 'for') continue;
      nodes.push(parseNode(rest.join('=')));
    }
  }
  return nodes;
}

/**
 * Resolves the client from the right of a chain: trusted proxies are skipped, the first
 * untrusted node is the client. A malformed node inside the trusted suffix fails closed, as does
 * a chain made only of trusted proxies.
 */
function walk(chain: (string | null)[], policy: TrustedProxyPolicy): ClientResolution {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = chain[i];
    if (node === null || node === undefined) return { ok: false, reason: 'malformed_chain' };
    if (!policy.isTrusted(node)) {
      const canonical = canonicalClientIdentifier(node);
      if (!canonical) return { ok: false, reason: 'malformed_chain' };
      return { ok: true, address: node, canonical, viaTrustedProxy: true };
    }
  }
  return { ok: false, reason: 'ambiguous_chain' };
}

export function resolveClient(
  input: { peerAddress: string | undefined; headers: IncomingHttpHeaders },
  policy: TrustedProxyPolicy,
): ClientResolution {
  const peer = input.peerAddress;
  if (peer === undefined || peer === '') return { ok: false, reason: 'no_peer' };
  const peerCanonical = canonicalClientIdentifier(peer);
  if (!peerCanonical) return { ok: false, reason: 'malformed_peer' };
  if (!policy.isTrusted(peer)) {
    // Headers from an untrusted peer are ignored entirely, whatever they say.
    return { ok: true, address: peer, canonical: peerCanonical, viaTrustedProxy: false };
  }
  const xff = headerValues(input.headers['x-forwarded-for']);
  const fwd = headerValues(input.headers.forwarded);
  const fromXff = xff.length > 0 ? walk(xff.map(parseNode), policy) : undefined;
  const fromFwd = fwd.length > 0 ? walk(forwardedNodes(fwd), policy) : undefined;
  if (fromXff && fromFwd) {
    if (!fromXff.ok || !fromFwd.ok) return fromXff.ok ? fromFwd : fromXff;
    return fromXff.canonical === fromFwd.canonical ? fromXff : { ok: false, reason: 'conflicting_headers' };
  }
  return fromXff ?? fromFwd ?? { ok: false, reason: 'ambiguous_chain' };
}

export interface ClientIdentity {
  /** HMAC-SHA256 of the canonical identifier under the configured key, hex. */
  hash: string;
  keyVersion: number;
}

export interface IdentifierKey {
  key: Buffer;
  version: number;
}

function keyed(key: IdentifierKey, domain: string, value: string): string {
  return createHmac('sha256', key.key).update(`${domain}:v${key.version}:${value}`, 'utf8').digest('hex');
}

/** The stored and audited form of a client (SEC-043, OPS-568). */
export function hashClientIdentifier(canonical: string, key: IdentifierKey): ClientIdentity {
  return { hash: keyed(key, 'client', canonical), keyVersion: key.version };
}

/** The throttle and ledger form of an account identifier: never the address itself. */
export function hashAccountIdentifier(emailNormalized: string, key: IdentifierKey): string {
  return keyed(key, 'account', emailNormalized);
}
