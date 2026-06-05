import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, '..');

// The `harper` package's `exports` map only exposes ".", so the harness's
// auto-resolution of 'harper/dist/bin/harper.js' fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
// Resolve the CLI from the (exported) main entry and pass it explicitly.
const require = createRequire(import.meta.url);
const harperBinPath = resolve(dirname(require.resolve('harper')), 'bin/harper.js');

function hFetch(ctx: ContextWithHarper, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
	const { headers = {}, ...rest } = init;
	const creds = Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	return fetch(`${ctx.harper.httpURL}${path}`, {
		...rest,
		headers: { Authorization: `Basic ${creds}`, ...headers },
	});
}

void suite('svelte-ssr-example', (ctx: ContextWithHarper) => {
	before(async () => {
		// NOTE: `dist/` must exist on disk before this runs (the component's
		// resources.js reads dist/client/index.html and imports
		// dist/server/entry-server.js at module load). Run `npm run build` first
		// (the CI workflow does this before the test step).
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// --- Core Harper / REST behavior ---

	void test('Harper starts and serves the seeded Post via REST', async () => {
		const res = await hFetch(ctx, '/Post/0');
		strictEqual(res.status, 200);
		const body = (await res.json()) as { id: string; title: string; body: string; comments: string[] };
		strictEqual(body.id, '0');
		strictEqual(body.title, 'Hello, World!');
		ok(Array.isArray(body.comments), 'expected comments array');
	});

	void test('GET /Post/ returns an array of posts', async () => {
		const res = await hFetch(ctx, '/Post/');
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(Array.isArray(body), 'expected array response');
	});

	void test('PATCH /Post/0 updates the record (REST write path)', async () => {
		const comment = `integration-test-${Math.random()}`;
		const current = (await (await hFetch(ctx, '/Post/0')).json()) as { comments: string[] };
		const res = await hFetch(ctx, '/Post/0', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ comments: [...current.comments, comment] }),
		});
		ok(res.ok, `expected successful PATCH, got HTTP ${res.status}`);

		const after = (await (await hFetch(ctx, '/Post/0')).json()) as { comments: string[] };
		ok(after.comments.includes(comment), 'updated comment should be persisted');
	});

	// --- SSR render path ---

	void test('UncachedBlog SSR-renders the post into HTML', async () => {
		const res = await hFetch(ctx, '/UncachedBlog/0');
		strictEqual(res.status, 200);
		strictEqual(res.headers.get('Content-Type'), 'text/html');
		const html = await res.text();
		// The Svelte App renders the post title inside an <h1>, and the
		// client hydration bootstrap injects window.__INITIAL_POST_DATA__.
		match(html, /Hello, World!/);
		match(html, /window\.__INITIAL_POST_DATA__/);
		match(html, /id="app"/);
	});

	// --- Harper multi-tier caching behavior (mirrors caching-test.js) ---

	void test('CachedBlog returns SSR HTML and honors conditional cache headers', async () => {
		// 1. Prime the cache (SSR render through the BlogCache source) and
		// confirm it carries the SSR'd page. On the first (cache-fill) request
		// Harper may serve the freshly sourced BlogCache record (as a
		// JSON-wrapped record) rather than the CachedBlog.get text/html
		// response, so assert the SSR marker appears in the raw body regardless
		// of which shape comes back rather than depending on a specific field.
		const r1 = await hFetch(ctx, '/CachedBlog/0');
		strictEqual(r1.status, 200);
		const r1Body = await r1.text();
		ok(r1Body.includes('Hello, World!'), `expected SSR'd page in response, got: ${r1Body.slice(0, 200)}`);

		const etag = r1.headers.get('ETag');
		const lastModified = r1.headers.get('Last-Modified');
		ok(etag || lastModified, 'expected an ETag or Last-Modified cache header');

		const conditionalHeaders: Record<string, string> = {};
		if (etag) conditionalHeaders['If-None-Match'] = etag;
		if (lastModified) conditionalHeaders['If-Modified-Since'] = lastModified;

		// 2. Re-request with the cache validators -> expect a 304 cache hit.
		const r2 = await hFetch(ctx, '/CachedBlog/0', { headers: conditionalHeaders });
		strictEqual(r2.status, 304, `expected 304 cache hit, got ${r2.status}`);

		// 3. Mutate the underlying Post -> should invalidate the cached page.
		const post = (await (await hFetch(ctx, '/Post/0')).json()) as { comments: string[] };
		const r3 = await hFetch(ctx, '/Post/0', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ comments: [...post.comments, `cache-invalidation-${Math.random()}`] }),
		});
		ok(r3.ok, `expected successful PATCH, got ${r3.status}`);

		// 4. Re-request with the stale validators -> expect a 200 (cache miss / re-render).
		const r4 = await hFetch(ctx, '/CachedBlog/0', { headers: conditionalHeaders });
		strictEqual(r4.status, 200, `expected 200 after invalidation, got ${r4.status}`);

		// 5. With the fresh validators we should once again get a 304.
		const freshHeaders: Record<string, string> = {};
		const etag4 = r4.headers.get('ETag');
		const lastModified4 = r4.headers.get('Last-Modified');
		if (etag4) freshHeaders['If-None-Match'] = etag4;
		if (lastModified4) freshHeaders['If-Modified-Since'] = lastModified4;
		const r5 = await hFetch(ctx, '/CachedBlog/0', { headers: freshHeaders });
		strictEqual(r5.status, 304, `expected 304 cache hit after re-render, got ${r5.status}`);
	});
});
