/**
 * Manual vendor simulator for UI testing. Sends one signed event (or a status call) exactly as a
 * real platform would.
 *
 *   HUB_KEY_ID=hk_... HUB_SECRET=... HUB_CONNECTION_ID=<uuid> BASE_URL=http://127.0.0.1:3000 \
 *     npm run hub:send -- session plant-001 trees_planted=40 volunteer_hours=32
 *
 *   npm run hub:send -- status
 *   npm run hub:send -- correct plant-001 <event_id_being_corrected> trees_planted=32
 *   npm run hub:send -- void plant-001
 *   npm run hub:send -- metric plant-001 survival_rate=87.5
 */
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { signHubRequest } from '../src/integration-hub/security/hub-hmac.util';

dotenv.config();

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(
  /\/$/,
  '',
);
const keyId = process.env.HUB_KEY_ID ?? '';
const secret = process.env.HUB_SECRET ?? '';
const connectionId = process.env.HUB_CONNECTION_ID ?? '';

async function send(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers = signHubRequest({ keyId, secret, method, path, body: raw });
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...headers,
      ...(raw ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw || undefined,
  });
  const text = await res.text();
  console.log(`${method} ${path} -> ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

function metricsFrom(args: string[]) {
  return args
    .filter((a) => a.includes('='))
    .map((a) => {
      const [code, v] = a.split('=');
      return { code, value: Number(v) };
    });
}

async function main() {
  const [cmd, activityId, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log(
      'commands: status | session <activityId> code=value... | metric <activityId> code=value... | correct <activityId> <correctsEventId> code=value... | void <activityId>',
    );
    return;
  }
  if (cmd === 'status') {
    await send('GET', '/api/integrations/v1/status');
    return;
  }
  if (!keyId || !secret || !connectionId) {
    throw new Error(
      'HUB_KEY_ID, HUB_SECRET and HUB_CONNECTION_ID are required',
    );
  }
  if (!activityId) throw new Error('activityId is required');
  const eventId = `${cmd}-${activityId}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const base = {
    schema_version: '1.0',
    event_id: eventId,
    connection_id: connectionId,
    occurred_at: new Date(Date.now() - 86_400_000).toISOString(),
    activity: {
      external_id: activityId,
      type: process.env.HUB_ACTIVITY_TYPE ?? 'plantation',
      title: `Manual test ${activityId}`,
    },
  };
  let event: Record<string, unknown>;
  switch (cmd) {
    case 'session':
      event = {
        ...base,
        event_type: 'activity.session',
        payload: {
          location: 'Lahore',
          session_hours: 4,
          participants_count: 8,
        },
        metrics: metricsFrom(rest),
      };
      break;
    case 'metric':
      event = {
        ...base,
        event_type: 'impact.metric',
        metrics: metricsFrom(rest),
      };
      break;
    case 'correct': {
      const [corrects, ...metricArgs] = rest;
      if (!corrects)
        throw new Error('correct needs the event_id being corrected');
      event = {
        ...base,
        event_type: 'activity.corrected',
        payload: {
          location: 'Lahore',
          session_hours: 4,
          participants_count: 8,
        },
        metrics: metricsFrom(metricArgs),
        correlation: { corrects },
      };
      break;
    }
    case 'void':
      event = { ...base, event_type: 'activity.voided' };
      break;
    default:
      throw new Error(`unknown command ${cmd}`);
  }
  console.log(`event_id: ${eventId}`);
  await send('POST', '/api/integrations/v1/events', [event]);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
