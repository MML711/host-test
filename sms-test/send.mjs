#!/usr/bin/env node
/**
 * SMS test — SMSEthiopia vs AfroMessage (AgriTrack, LT-5 research).
 * Sends one of AgriTrack's real texts through a provider's API, then asks the provider for its delivery status
 * until the message reaches a final state (or 3 minutes pass). Results are appended to results.csv.
 *
 *   node send.mjs --provider smsethiopia --to 0911234567 --text 1
 *   node send.mjs --provider afromessage --to 0711234567 --text 3
 *   node send.mjs --texts                      (show the four texts and their size)
 *
 * Keys come from sms-test/.env (see .env.example) — never committed, never printed. results.csv holds phone
 * numbers, so it isn't committed either.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL_EVERY_MS = 5_000;
const POLL_FOR_MS = 180_000;

// --- settings -----------------------------------------------------------------------------------------------
function loadEnv() {
  const file = path.join(HERE, '.env');
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !m[2].startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = { ...loadEnv(), ...process.env };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// --- the texts (1 and 3 are AgriTrack's real wording, from API/src/shared/security/accountMessages.js) ----------
const randomCode = () => String(Math.floor(100000 + Math.random() * 900000));
const ALERT = "The phone number on your AgriTrack account was changed to •••••••••••78. If this wasn't you, contact AgriTrack support right away.";

function amharicText(code) {
  const file = path.join(HERE, 'amharic.txt');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim() : '';
  if (!text || text.startsWith('WRITE')) throw new Error('Write the Amharic code text on the first line of sms-test/amharic.txt, with {code} where the code goes.');
  return text.replace('{code}', code);
}

const TEXTS = {
  1: (code) => `${code} is your AgriTrack verification code. It expires in 10 minutes. Don't share it with anyone.`,
  2: (code) => amharicText(code),
  3: () => ALERT,
  4: () => ALERT.replace(/•/g, '*'),
};

// GSM-7 texts fit 160 characters in one SMS (153 per part when split); anything else is Unicode: 70 (67 per part).
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€";
function size(text) {
  const chars = [...text];
  const gsm = chars.every((c) => GSM.includes(c));
  const n = chars.length;
  const parts = gsm ? (n <= 160 ? 1 : Math.ceil(n / 153)) : (n <= 70 ? 1 : Math.ceil(n / 67));
  return { encoding: gsm ? 'GSM-7' : 'Unicode', characters: n, parts };
}

// --- numbers --------------------------------------------------------------------------------------------------
function normalize(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (/^0[79]\d{8}$/.test(digits)) return `251${digits.slice(1)}`;
  if (/^[79]\d{8}$/.test(digits)) return `251${digits}`;
  if (/^251[79]\d{8}$/.test(digits)) return digits;
  throw new Error(`Not an Ethiopian mobile number: ${input}`);
}
const network = (msisdn) => (msisdn.startsWith('2519') ? 'Ethio Telecom' : msisdn.startsWith('2517') ? 'Safaricom' : 'unknown');

// --- providers ------------------------------------------------------------------------------------------------
async function readJson(response) {
  const body = await response.text();
  try { return JSON.parse(body); } catch { return { raw: body.slice(0, 300) }; }
}

const PROVIDERS = {
  smsethiopia: {
    key: () => env.SMSETHIOPIA_KEY,
    // API v2: a real message id, the parts charged, and a status lookup (docs: smsethiopia.com/#/landing/docs/api-v2).
    async send(msisdn, text) {
      const res = await fetch('https://smsethiopia.com/api/v2/sms/send', {
        method: 'POST',
        headers: { KEY: env.SMSETHIOPIA_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ msisdn, text }),
      });
      const body = await readJson(res);
      return { httpStatus: res.status, body, id: body.id || null, status: body.status || null, parts: body.segments ?? null };
    },
    async status(id) {
      const res = await fetch(`https://smsethiopia.com/api/v2/sms/${encodeURIComponent(id)}`, { headers: { KEY: env.SMSETHIOPIA_KEY } });
      const body = await readJson(res);
      return { httpStatus: res.status, body, status: body.status || null };
    },
    isFinal: (status) => ['DELIVERED', 'FAILED', 'UNDELIVERED', 'REJECTED', 'EXPIRED'].includes(String(status).toUpperCase()),
  },
  afromessage: {
    key: () => env.AFROMESSAGE_TOKEN,
    // https://api.afromessage.com/api/send — Bearer token; `from` (identifier id) and `sender` are optional.
    async send(msisdn, text) {
      const payload = { to: `+${msisdn}`, message: text };
      if (env.AFROMESSAGE_FROM) payload.from = env.AFROMESSAGE_FROM;
      if (env.AFROMESSAGE_SENDER) payload.sender = env.AFROMESSAGE_SENDER;
      const res = await fetch('https://api.afromessage.com/api/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.AFROMESSAGE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      const r = body.response || {};
      return { httpStatus: res.status, body, id: r.message_id || r.messageId || r.id || null, status: r.status || body.acknowledge || null, parts: null };
    },
    async status(id) {
      const res = await fetch(`https://api.afromessage.com/api/status?id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${env.AFROMESSAGE_TOKEN}` },
      });
      const body = await readJson(res);
      const r = body.response || {};
      return { httpStatus: res.status, body, status: r.status || r.state || null };
    },
    isFinal: (status) => ['DELIVERED', 'FAILED', 'UNDELIVERED', 'REJECTED', 'EXPIRED'].includes(String(status).toUpperCase()),
  },
};

// --- run --------------------------------------------------------------------------------------------------------
const seconds = (since) => Math.round((Date.now() - since) / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendCsv(row) {
  const file = path.join(HERE, 'results.csv');
  const columns = ['sent_at_utc', 'sent_at_local', 'provider', 'network', 'text', 'encoding', 'parts_expected', 'parts_charged', 'http', 'id', 'first_status', 'final_status', 'seconds_to_final', 'note'];
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${columns.join(',')}\n`);
  fs.appendFileSync(file, `${columns.map((c) => `"${String(row[c] ?? '').replace(/"/g, '""')}"`).join(',')}\n`);
}

async function main() {
  if (process.argv.includes('--texts')) {
    for (const [n, make] of Object.entries(TEXTS)) {
      try {
        const text = make('482915');
        console.log(`Text ${n}: ${JSON.stringify(size(text))}\n  ${text}\n`);
      } catch (error) {
        console.log(`Text ${n}: ${error.message}\n`);
      }
    }
    return;
  }

  const providerName = arg('provider');
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error('Use --provider smsethiopia or --provider afromessage');
  if (!provider.key()) throw new Error(`No key for ${providerName} — add it to sms-test/.env (see .env.example)`);
  const msisdn = normalize(arg('to'));
  const textNumber = arg('text') || '1';
  if (!TEXTS[textNumber]) throw new Error('Use --text 1, 2, 3 or 4');
  const text = TEXTS[textNumber](randomCode());
  const shape = size(text);

  const sentAt = new Date();
  const since = Date.now();
  console.log(`${sentAt.toLocaleTimeString()}  ${providerName} → ${network(msisdn)} (…${msisdn.slice(-2)}), text ${textNumber} (${shape.encoding}, ${shape.characters} characters, ${shape.parts} part${shape.parts > 1 ? 's' : ''})`);

  const sent = await provider.send(msisdn, text);
  console.log(`  send → HTTP ${sent.httpStatus}: ${JSON.stringify(sent.body)}`);

  const row = {
    sent_at_utc: sentAt.toISOString(), sent_at_local: sentAt.toLocaleString(), provider: providerName, network: network(msisdn),
    text: textNumber, encoding: shape.encoding, parts_expected: shape.parts, parts_charged: sent.parts, http: sent.httpStatus,
    id: sent.id, first_status: sent.status,
  };

  if (!sent.id) {
    row.note = 'no message id — see the send response above';
    appendCsv(row);
    console.log('  No message id came back, so the status cannot be followed. Check the phone and the provider dashboard.');
    return;
  }

  let last = sent.status;
  while (Date.now() - since < POLL_FOR_MS) {
    await sleep(POLL_EVERY_MS);
    const now = await provider.status(sent.id);
    if (now.status !== last) {
      console.log(`  +${seconds(since)} s: ${now.status ?? JSON.stringify(now.body)}`);
      last = now.status;
    }
    if (now.status && provider.isFinal(now.status)) break;
  }
  row.final_status = last;
  row.seconds_to_final = provider.isFinal(last) ? seconds(since) : '';
  row.note = provider.isFinal(last) ? '' : `still ${last} after ${POLL_FOR_MS / 1000} s`;
  appendCsv(row);
  console.log(`  Final: ${last}${row.seconds_to_final ? ` after ~${row.seconds_to_final} s` : ` (not final after ${POLL_FOR_MS / 1000} s)`} — also note when the phone actually showed it.`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
