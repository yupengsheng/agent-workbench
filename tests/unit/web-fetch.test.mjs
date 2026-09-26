import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReadOnlyToolRegistry,
  parseWebFetchAllowlist,
  RestrictedWebFetcher,
} from '../../packages/tools/dist/index.js';

const publicAddress = [{ address: '8.8.8.8', family: 4 }];

function response(statusCode, headers = {}, body = '') {
  return {
    statusCode,
    headers,
    body: Buffer.from(body),
    truncated: false,
  };
}

test('web fetch allowlist normalizes hosts and rejects URL-shaped entries', () => {
  assert.deepEqual(parseWebFetchAllowlist('Example.COM, *.Docs.Example.com,example.com'), [
    'example.com',
    '*.docs.example.com',
  ]);
  assert.deepEqual(parseWebFetchAllowlist(undefined), []);
  assert.throws(() => parseWebFetchAllowlist('https://example.com/path'));
  assert.throws(() => parseWebFetchAllowlist('*.127.0.0.1'));
});

test('web fetch blocks protected literal addresses before opening a socket', async () => {
  const protectedAddresses = [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '0.0.0.0',
    '224.0.0.1',
    '[::1]',
    '[fc00::1]',
    '[fe80::1]',
    '[2001:db8::1]',
    '[64:ff9b::1]',
    '[::ffff:127.0.0.1]',
  ];
  for (const host of protectedAddresses) {
    let requested = false;
    const fetcher = new RestrictedWebFetcher(
      { allowedHosts: [host] },
      {
        request: async () => {
          requested = true;
          return response(200, { 'content-type': 'text/plain' }, 'unsafe');
        },
      },
    );
    const result = await fetcher.fetch(`http://${host}/latest/meta-data`);
    assert.equal(result.status, 'denied', host);
    assert.equal(result.errorCode, 'address_denied', host);
    assert.equal(requested, false, host);
  }
});

test('web fetch rejects mixed DNS answers and validates every redirect target', async () => {
  let requestCount = 0;
  const mixed = new RestrictedWebFetcher(
    { allowedHosts: ['mixed.example'] },
    {
      lookup: async () => [...publicAddress, { address: '127.0.0.1', family: 4 }],
      request: async () => {
        requestCount += 1;
        return response(200, { 'content-type': 'text/plain' }, 'unsafe');
      },
    },
  );
  assert.equal((await mixed.fetch('https://mixed.example/')).errorCode, 'address_denied');
  assert.equal(requestCount, 0);

  const redirected = new RestrictedWebFetcher(
    { allowedHosts: ['public.example', 'next.example'] },
    {
      lookup: async (hostname) =>
        hostname === 'next.example' ? [{ address: '169.254.169.254', family: 4 }] : publicAddress,
      request: async () => {
        requestCount += 1;
        return response(302, { location: 'https://next.example/private' });
      },
    },
  );
  const result = await redirected.fetch('https://public.example/start');
  assert.equal(result.status, 'denied');
  assert.equal(result.errorCode, 'address_denied');
  assert.equal(requestCount, 1);
});

test('web fetch applies the total timeout and cancellation while resolving DNS', async () => {
  const never = () => new Promise(() => {});
  const timed = new RestrictedWebFetcher(
    { allowedHosts: ['slow.example'], timeoutMs: 5 },
    { lookup: never },
  );
  assert.equal((await timed.fetch('https://slow.example/')).errorCode, 'dns_timeout');

  const controller = new AbortController();
  const cancelled = new RestrictedWebFetcher({ allowedHosts: ['slow.example'] }, { lookup: never });
  const pending = cancelled.fetch('https://slow.example/', controller.signal);
  controller.abort();
  assert.deepEqual(await pending, {
    status: 'cancelled',
    errorCode: 'cancelled',
    message: '网页获取已取消',
  });
});

test('web fetch pins the validated address and returns bounded UTF-8 text', async () => {
  const requests = [];
  const fetcher = new RestrictedWebFetcher(
    { allowedHosts: ['*.example.com'], maxResponseBytes: 1024 },
    {
      lookup: async (hostname) => {
        assert.equal(hostname, 'docs.example.com');
        return publicAddress;
      },
      request: async (url, address, limits) => {
        requests.push({ url: url.toString(), address, limits });
        return response(200, { 'content-type': 'text/html; charset=utf-8' }, '<h1>Docs</h1>');
      },
    },
  );
  assert.equal((await fetcher.fetch('https://example.com/')).errorCode, 'host_denied');
  const result = await fetcher.fetch('https://docs.example.com/guide#section');
  assert.deepEqual(result, {
    status: 'success',
    url: 'https://docs.example.com/guide',
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    content: '<h1>Docs</h1>',
    bytes: 13,
    redirects: 0,
    truncated: false,
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].address, publicAddress[0]);
  assert.equal(requests[0].limits.maxResponseBytes, 1024);
});

test('web fetch denies downgrade, compressed and non-text responses', async () => {
  const cases = [
    {
      response: response(302, { location: 'http://public.example/insecure' }),
      errorCode: 'redirect_downgrade',
    },
    {
      response: response(
        200,
        { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        'compressed',
      ),
      errorCode: 'content_encoding_denied',
    },
    {
      response: response(200, { 'content-type': 'application/octet-stream' }, 'binary'),
      errorCode: 'content_type_denied',
    },
  ];
  for (const item of cases) {
    const fetcher = new RestrictedWebFetcher(
      { allowedHosts: ['public.example'] },
      {
        lookup: async () => publicAddress,
        request: async () => item.response,
      },
    );
    const result = await fetcher.fetch('https://public.example/start');
    assert.equal(result.status, 'denied');
    assert.equal(result.errorCode, item.errorCode);
  }
});

test('web tool is absent by default and exposes only the configured fetcher result', async () => {
  const disabled = createReadOnlyToolRegistry('/tmp');
  assert(!disabled.definitions().some((item) => item.function.name === 'fetch_web_page'));

  const enabled = createReadOnlyToolRegistry('/tmp', {
    web: {
      enabled: true,
      allowedHosts: ['docs.example.com'],
      fetcher: {
        async fetch(url) {
          assert.equal(url, 'https://docs.example.com/guide');
          return {
            status: 'success',
            url,
            statusCode: 200,
            contentType: 'text/plain',
            content: 'd'.repeat(40_000),
            bytes: 40_000,
            redirects: 0,
            truncated: false,
          };
        },
      },
    },
  });
  assert(enabled.definitions().some((item) => item.function.name === 'fetch_web_page'));
  const result = await enabled.execute(
    'fetch_web_page',
    JSON.stringify({ url: 'https://docs.example.com/guide' }),
    { workspaceId: '11111111-1111-4111-8111-111111111111' },
  );
  assert.equal(result.status, 'success');
  const output = JSON.parse(result.content);
  assert.equal(output.content.length, 32_000 - 4_096);
  assert.equal(output.truncated, true);
  assert.deepEqual(output.citation, { url: 'https://docs.example.com/guide' });
});
