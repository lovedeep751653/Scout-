import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { hmacHex } from '../security/crypto.ts';

const v4Blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) v4Blocked.addSubnet(net, prefix, 'ipv4');

// Only global unicast IPv6 (2000::/3) is allowed, minus documentation, 6to4, Teredo and NAT64 ranges.
const v6Global = new BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');
const v6Blocked = new BlockList();
for (const [net, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['64:ff9b::', 96], ['3fff::', 20]] as const) {
  v6Blocked.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped) return isBlockedIp(mapped[1]!);
    return !v6Global.check(ip, 'ipv6') || v6Blocked.check(ip, 'ipv6');
  }
  return true;
}

export class WebhookError extends Error {}

const BLOCKED_HOSTS = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

export function checkWebhookUrl(raw: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError('The webhook URL is not valid.');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new WebhookError('The webhook URL must start with https://');
  if (url.username || url.password) throw new WebhookError('The webhook URL must not contain a username or password.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.test(host)) throw new WebhookError('The webhook URL points to a private address.');
  if (isIP(host) && isBlockedIp(host)) throw new WebhookError('The webhook URL points to a private address.');
  if (raw.length > 2000) throw new WebhookError('The webhook URL is too long.');
  return url;
}

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const defaultResolver: Resolver = (host) => dns.lookup(host, { all: true, verbatim: true });

export interface WebhookCall {
  url: string;
  secret: string;
  payload: unknown;
  timeoutMs: number;
  maxResponseBytes: number;
  allowHttp?: boolean;
  maxRequestBytes?: number;
  // Test-only switches; never read from the environment.
  resolver?: Resolver;
  allowPrivateForTests?: boolean;
}

export interface WebhookResult {
  status: number;
  data: unknown;
}

export function signBody(secret: string, timestamp: number, body: string): string {
  return `v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

export async function callWebhook(call: WebhookCall): Promise<WebhookResult> {
  const url = checkWebhookUrl(call.url, call.allowHttp ?? false);
  const body = JSON.stringify(call.payload);
  if (Buffer.byteLength(body) > (call.maxRequestBytes ?? 32_768)) throw new WebhookError('The tool input is too large to send.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await (call.resolver ?? defaultResolver)(host).catch(() => []);
  if (addresses.length === 0) throw new WebhookError('Could not find the webhook server (DNS lookup failed).');
  if (!call.allowPrivateForTests && addresses.some((a) => isBlockedIp(a.address))) {
    throw new WebhookError('The webhook URL points to a private address.');
  }
  const chosen = addresses[0]!;
  // Connect to the address we just checked, so a second DNS answer cannot redirect us.
  const lookup: LookupFunction = (_hostname, options, cb) => {
    if (options && (options as { all?: boolean }).all) {
      (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: chosen.address, family: chosen.family }]);
    } else {
      cb(null, chosen.address, chosen.family);
    }
  };
  const timestamp = Math.floor(Date.now() / 1000);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<WebhookResult>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'POST',
        lookup,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Scout-Webhook/1.0',
          'x-scout-timestamp': String(timestamp),
          'x-scout-signature': signBody(call.secret, timestamp, body),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          req.destroy();
          return reject(new WebhookError('The webhook tried to redirect; redirects are not allowed.'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > call.maxResponseBytes) {
            req.destroy();
            reject(new WebhookError(`The webhook answer was larger than ${call.maxResponseBytes} bytes.`));
          } else chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: unknown = text;
          if (/json/i.test(String(res.headers['content-type'] ?? ''))) {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
          if (status < 200 || status >= 300) return reject(new WebhookError(`The webhook answered with HTTP ${status}.`));
          resolve({ status, data });
        });
        res.on('error', (e) => reject(new WebhookError(`The webhook connection failed: ${e.message}`)));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new WebhookError(`The webhook did not answer within ${call.timeoutMs} ms.`));
    }, call.timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (e) => reject(new WebhookError(`The webhook connection failed: ${e.message}`)));
    req.end(body);
  });
}
