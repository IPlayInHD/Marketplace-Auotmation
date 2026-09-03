import { z } from 'zod';

// Every write carries the request that caused it (OPS-720, OPS-791). Every consequential action
// additionally carries a client-supplied idempotency key (OPS-730, CLAUDE.md engineering rules).
// The seller id in a context is the authenticated principal's; in this slice it is a synthetic,
// founder-controlled identity supplied by the caller, because authentication is out of scope (Q-12).

const Identifier = z.string().min(1).max(128);

export const WriteContextSchema = z.strictObject({
  sellerId: z.uuid(),
  requestId: Identifier,
});
export type WriteContext = z.infer<typeof WriteContextSchema>;

export const CommandContextSchema = WriteContextSchema.extend({
  idempotencyKey: Identifier,
});
export type CommandContext = z.infer<typeof CommandContextSchema>;

export function writeContext(input: WriteContext): WriteContext {
  return WriteContextSchema.parse(input);
}

export function commandContext(input: CommandContext): CommandContext {
  return CommandContextSchema.parse(input);
}
