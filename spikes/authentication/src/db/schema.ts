import type { Generated } from 'kysely';

// Kysely table types. The auth.* tables exist only in this spike; the app.* tables are the
// production ones created by backend/src/db/migrations, read here to prove tenant resolution
// against the real row-level-security policies.

export interface SellerAccountTable {
  id: Generated<string>;
  seller_id: string;
  email: string;
  email_normalized: string;
  /** Argon2id PHC string. The column CHECK admits nothing else. */
  password_hash: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SellerSessionTable {
  id: Generated<string>;
  account_id: string;
  /** SHA-256 of the token, 32 bytes. The token itself is never stored. */
  token_hash: Buffer;
  /** Hashed client identifier (SEC-043), never a raw address. */
  client_hash: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  absolute_expires_at: Date;
  revoked_at: Generated<Date | null>;
  revocation_reason: Generated<string | null>;
  replaced_by_session_id: Generated<string | null>;
}

export interface AppSellerTable {
  id: string;
  display_name: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AppInventoryItemTable {
  id: Generated<string>;
  seller_id: string;
  acquisition_cost_minor: Generated<number | null>;
  acquisition_currency: Generated<string | null>;
  acquisition_date: Generated<string | null>;
  request_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  'auth.seller_account': SellerAccountTable;
  'auth.seller_session': SellerSessionTable;
  'app.seller': AppSellerTable;
  'app.inventory_item': AppInventoryItemTable;
}
