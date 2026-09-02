import type { Generated } from 'kysely';

// Kysely table types for the spike schema. Table keys are unqualified because the Kysely
// instance is created with withSchema('app') (see kysely.ts).

export interface ListingsTable {
  id: Generated<string>;
  seller_id: string;
  title: string;
  asking_price_minor: number;
  currency: string;
  minimum_price_minor: number;
  internal_notes: Generated<string>;
  seller_display_name: string;
  created_at: Generated<Date>;
}

export interface DemoRecordsTable {
  id: Generated<string>;
  seller_id: string;
  payload: string;
  created_at: Generated<Date>;
}

export interface SideEffectsTable {
  id: Generated<string>;
  seller_id: string;
  effect_key: string;
  job_id: string;
  created_at: Generated<Date>;
}

export interface Database {
  listings: ListingsTable;
  demo_records: DemoRecordsTable;
  side_effects: SideEffectsTable;
}
