import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2_048;

export interface WebFetchPolicy {
  allowedHosts: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

export interface WebFetchResult {
  status: 'success' | 'error' | 'denied' | 'cancelled';
  url?: string;
  statusCode?: number;
  contentType?: string;
  content?: string;
  bytes?: number;
  redirects?: number;
  truncated?: boolean;
  errorCode?: string;
  message?: string;
}

interface TransportResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

interface RequestLimits {
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface WebFetchDependencies {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (
    url: URL,
    address: LookupAddress,
    limits: RequestLimits,
    signal?: AbortSignal,
  ) => Promise<TransportResponse>;
}

class WebFetchFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly denied = false,
  ) {
    super(message);
    this.name = 'WebFetchFailure';
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error('web fetch limit is invalid');
  return value;
}

function normalizeHostname(value: string): string {
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const hostname = unwrapped.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253) throw new Error('web fetch host is invalid');
  return hostname;
}

function normalizeAllowedHost(value: string): string {
  const input = value.trim().toLowerCase();
  if (!input) throw new Error('web fetch allowlist contains an empty host');
  const wildcard = input.startsWith('*.');
  const candidate = wildcard ? input.slice(2) : input;
  let url: URL;
  try {
    url = new URL(`https://${candidate}`);
  } catch {
    throw new Error('web fetch allowlist contains an invalid host');
  }
  if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('web fetch allowlist entries must contain only host names');
  }
  const hostname = normalizeHostname(url.hostname);
  if (wildcard && isIP(hostname)) throw new Error('web fetch IP entries cannot use wildcards');
  return wildcard ? `*.${hostname}` : hostname;
}

export function parseWebFetchAllowlist(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(',').map(normalizeAllowedHost))];
}

function isAllowedHost(hostname: string, allowedHosts: string[]) {
  return allowedHosts.some((entry) => {
    if (!entry.startsWith('*.')) return hostname === entry;
    const suffix = entry.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  });
}

function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
      return parsed.toIPv4Address().range() === 'unicast';
    }
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function validateUrl(input: string, allowedHosts: string[]): URL {
  if (!input || input.length > MAX_URL_LENGTH)
    throw new WebFetchFailure('invalid_url', '网页地址不能为空且不能超过 2048 个字符');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebFetchFailure('invalid_url', '网页地址格式不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new WebFetchFailure('scheme_denied', '只允许 HTTP 或 HTTPS 地址', true);
  if (url.username || url.password)
    throw new WebFetchFailure('credentials_denied', '网页地址不能包含用户名或密码', true);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443')
    throw new WebFetchFailure('port_denied', '网页获取只允许 80 或 443 端口', true);
  const hostname = normalizeHostname(url.hostname);
  if (!isAllowedHost(hostname, allowedHosts))
    throw new WebFetchFailure('host_denied', '目标域名不在网页获取白名单中', true);
  url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  url.hash = '';
  return url;
}

async function resolvePublicAddress(
  hostname: string,
  lookup: (hostname: string) => Promise<LookupAddress[]>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const literalFamily = isIP(hostname);
  let addresses: LookupAddress[];
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const timer = setTimeout(
        () => finish(() => reject(new WebFetchFailure('dns_timeout', '目标域名解析超时'))),
        timeoutMs,
      );
      const onAbort = () =>
        finish(() => reject(new WebFetchFailure('cancelled', '网页获取已取消')));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      lookup(hostname).then(
        (result) => finish(() => resolve(result)),
        () => finish(() => reject(new WebFetchFailure('dns_failed', '目标域名解析失败'))),
      );
    });
  }
  if (addresses.length === 0) throw new WebFetchFailure('dns_failed', '目标域名没有可用地址');
  if (addresses.some((item) => !publicAddress(item.address)))
    throw new WebFetchFailure('address_denied', '目标域名解析到受保护地址', true);
  return addresses[0] as LookupAddress;
}

function defaultLookup(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function requestOnce(
  url: URL,
  address: LookupAddress,
  limits: RequestLimits,
  signal?: AbortSignal,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WebFetchFailure('cancelled', '网页获取已取消'));
      return;
    }
    const requestHostname = normalizeHostname(url.hostname);
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      agent: false,
      headers: {
        host: url.host,
        accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1',
        'accept-encoding': 'identity',
        'user-agent': 'Agent-Workbench-WebFetch/1.0',
      },
      ...(url.protocol === 'https:' && !isIP(requestHostname)
        ? { servername: requestHostname }
        : {}),
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const request = send(options, (response) => {
      const statusCode = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        finish(() =>
          resolve({
            statusCode,
            headers: response.headers,
            body: Buffer.alloc(0),
            truncated: false,
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        const remaining = limits.maxResponseBytes - bytes;
        if (chunk.byteLength <= remaining) {
          chunks.push(chunk);
          bytes += chunk.byteLength;
          return;
        }
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes += Math.max(0, remaining);
        response.destroy();
        request.destroy();
        finish(() =>
          resolve({
            statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks, bytes),
            truncated: true,
          }),
        );
      });
      response.on('end', () => {
        finish(() =>
          resolve({
            statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks, bytes),
            truncated: false,
          }),
        );
      });
      response.on('error', (error) => finish(() => reject(error)));
    });
    const onAbort = () => request.destroy(new WebFetchFailure('cancelled', '网页获取已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    deadlineTimer = setTimeout(() => {
      request.destroy(new WebFetchFailure('fetch_timeout', '网页获取超时'));
    }, limits.timeoutMs);
    request.on('error', (error) => finish(() => reject(error)));
    request.end();
  });
}

function textualContentType(value: string) {
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType.endsWith('+json') ||
    mediaType === 'application/xml' ||
    mediaType.endsWith('+xml')
  );
}

function validCharset(value: string) {
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(value)?.[1]?.toLowerCase();
  return (
    charset === undefined || charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii'
  );
}

export class RestrictedWebFetcher {
  private readonly allowedHosts: string[];
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly lookup: (hostname: string) => Promise<LookupAddress[]>;
  private readonly request: NonNullable<WebFetchDependencies['request']>;

  constructor(policy: WebFetchPolicy, dependencies: WebFetchDependencies = {}) {
    this.allowedHosts = [...new Set(policy.allowedHosts.map(normalizeAllowedHost))];
    if (this.allowedHosts.length === 0) throw new Error('web fetch allowlist is empty');
    this.timeoutMs = boundedInteger(policy.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.maxResponseBytes = boundedInteger(
      policy.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    );
    this.maxRedirects = boundedInteger(policy.maxRedirects, DEFAULT_MAX_REDIRECTS, MAX_REDIRECTS);
    this.lookup = dependencies.lookup ?? defaultLookup;
    this.request = dependencies.request ?? requestOnce;
  }

  async fetch(input: string, signal?: AbortSignal): Promise<WebFetchResult> {
    const deadline = Date.now() + this.timeoutMs;
    let redirects = 0;
    try {
      let current = validateUrl(input, this.allowedHosts);
      while (true) {
        if (signal?.aborted) throw new WebFetchFailure('cancelled', '网页获取已取消');
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new WebFetchFailure('fetch_timeout', '网页获取超时');
        const address = await resolvePublicAddress(
          normalizeHostname(current.hostname),
          this.lookup,
          remaining,
          signal,
        );
        const requestTimeoutMs = deadline - Date.now();
        if (requestTimeoutMs <= 0) throw new WebFetchFailure('fetch_timeout', '网页获取超时');
        const response = await this.request(
          current,
          address,
          { timeoutMs: requestTimeoutMs, maxResponseBytes: this.maxResponseBytes },
          signal,
        );
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          if (redirects >= this.maxRedirects)
            throw new WebFetchFailure('too_many_redirects', '网页跳转次数超过限制', true);
          const location = headerValue(response.headers, 'location');
          if (!location) throw new WebFetchFailure('invalid_redirect', '网页跳转缺少目标地址');
          const next = validateUrl(new URL(location, current).toString(), this.allowedHosts);
          if (current.protocol === 'https:' && next.protocol !== 'https:')
            throw new WebFetchFailure('redirect_downgrade', '不允许从 HTTPS 跳转到 HTTP', true);
          current = next;
          redirects += 1;
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return {
            status: 'error',
            url: current.toString(),
            statusCode: response.statusCode,
            redirects,
            errorCode: 'http_status',
            message: `网页返回 HTTP ${response.statusCode}`,
          };
        }
        const encoding = headerValue(response.headers, 'content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity')
          throw new WebFetchFailure('content_encoding_denied', '网页返回了不支持的压缩格式', true);
        const contentType = headerValue(response.headers, 'content-type') ?? '';
        if (!textualContentType(contentType))
          throw new WebFetchFailure('content_type_denied', '网页响应不是允许的文本类型', true);
        if (!validCharset(contentType))
          throw new WebFetchFailure('charset_denied', '网页响应不是 UTF-8 文本', true);
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
        } catch {
          throw new WebFetchFailure('invalid_utf8', '网页响应不是有效的 UTF-8 文本', true);
        }
        return {
          status: 'success',
          url: current.toString(),
          statusCode: response.statusCode,
          contentType,
          content,
          bytes: response.body.byteLength,
          redirects,
          truncated: response.truncated,
        };
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof WebFetchFailure && error.code === 'cancelled')) {
        return { status: 'cancelled', errorCode: 'cancelled', message: '网页获取已取消' };
      }
      if (error instanceof WebFetchFailure) {
        return {
          status: error.denied ? 'denied' : 'error',
          errorCode: error.code,
          message: error.message,
        };
      }
      return { status: 'error', errorCode: 'network_error', message: '网页获取失败' };
    }
  }
}
