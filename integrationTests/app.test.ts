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

	// --- SSR render path (cached) ---
	// This runs before any Post mutation so the BlogCache entry is pristine: a
	// first-fill CachedBlog read deterministically serves the full SSR page.
	void test('CachedBlog serves the SSR-rendered page as text/html', async () => {
		const res = await hFetch(ctx, '/CachedBlog/0');
		strictEqual(res.status, 200);
		strictEqual(res.headers.get('Content-Type'), 'text/html');
		const html = await res.text();
		// Full SSR document: rendered post + client-hydration bootstrap.
		match(html, /Hello, World!/);
		match(html, /window\.__INITIAL_POST_DATA__/);
		match(html, /id="app"/);
	});

	// --- SSR render path (uncached) ---

	void test('UncachedBlog SSR-renders the post into HTML', async () => {
		const res = await hFetch(ctx, '/UncachedBlog/0');
		strictEqual(res.status, 200);
		strictEqual(res.headers.get('Content-Type'), 'text/html');
		const html = await res.text();
		match(html, /Hello, World!/);
		match(html, /window\.__INITIAL_POST_DATA__/);
		match(html, /id="app"/);
	});

	// --- REST write path + live (uncached) re-render ---
	// Defined last because it mutates the seeded Post. UncachedBlog re-renders
	// live from the Post on every request, so it reflects the write immediately.
	void test('PATCH /Post/0 persists and UncachedBlog reflects the update live', async () => {
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

		const rendered = await (await hFetch(ctx, '/UncachedBlog/0')).text();
		ok(rendered.includes(comment), 'UncachedBlog should re-render with the updated comment');
	});
});
