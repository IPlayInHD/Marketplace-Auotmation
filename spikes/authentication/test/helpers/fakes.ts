import { Writable } from 'node:stream';
import type { AuditEvent, AuditSink, RateLimitGate, RateLimitScope, Trx } from '../../src/auth/ports.ts';

/** Collects audit events in memory, as the transaction sees them, for scanning in assertions. */
export function memoryAuditSink(): AuditSink & { events: AuditEvent[]; text(): string } {
  const events: AuditEvent[] = [];
  return {
    events,
    text: () => JSON.stringify(events),
    append: (_trx: Trx, event: AuditEvent) => {
      events.push(structuredClone(event));
      return Promise.resolve();
    },
  };
}

/** Records every consultation; refuses only when told to. */
export function recordingGate(): RateLimitGate & {
  calls: { scope: RateLimitScope; key: string }[];
  refuse: boolean;
} {
  const gate = {
    calls: [] as { scope: RateLimitScope; key: string }[],
    refuse: false,
    consume: (scope: RateLimitScope, key: string) => {
      gate.calls.push({ scope, key });
      return Promise.resolve(!gate.refuse);
    },
  };
  return gate;
}

/** A pino destination that keeps every line. */
export function capturingStream(): Writable & { lines: string[]; text(): string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  }) as Writable & { lines: string[]; text(): string };
  stream.lines = lines;
  stream.text = () => lines.join('');
  return stream;
}
