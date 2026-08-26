import { tables } from 'harper';
import fs from 'node:fs';
import path from 'node:path';

if (!(await tables.Post.get('0'))) {
	await tables.Post.put({
		id: '0',
		title: 'Hello, World!',
		body: 'This is a test post. Please leave a comment! 📝',
		comments: [],
	});
}

const htmlPath = path.join(import.meta.dirname, 'dist/client/index.html');
const templateHTML = fs.readFileSync(htmlPath, 'utf-8');
const serverEntry = await import('./dist/server/entry-server.js');

async function renderPost(post) {
	const rendered = serverEntry.render({ initialPostData: post });

	const html = templateHTML
		.replace(`<!--app-head-->`, rendered.head ?? '')
		.replace(`<!--app-html-->`, rendered.html ?? '')
		.replace(`<!--app-data-->`, `<script>window.__INITIAL_POST_DATA__ = ${JSON.stringify(post).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')};</script>`);

	return html;
}

// Shared by the live (UncachedBlog) and cache-source (PageBuilder) paths: both
// answer with the same SSR'd HTTP response descriptor for a given Post id.
// Returns null when the Post does not exist so each caller can decide what a
// miss means.
async function renderPostResponse(target) {
	const post = await tables.Post.get(target);
	if (!post) return null;
	return {
		status: 200,
		headers: { 'Content-Type': 'text/html' },
		body: await renderPost(post),
	};
}

export class UncachedBlog extends tables.Post {
	static async get(target) {
		return (await renderPostResponse(target)) ?? { status: 404, body: 'Not Found' };
	}
}

// Caching source for BlogCache. Harper's caching layer parses the sourced
// `{ status, headers, body }` response, stores the rendered HTML body (with its
// Content-Type) in BlogCache, and serves it with the right content type on
// cache hits.
// A missing Post returns null rather than a 404 descriptor: Harper treats a
// falsy source result as "this source cannot fulfill" and writes nothing to
// BlogCache, so the 404 is not cached as if it were the page.
// NOTE (Harper v5, 5.0.x): after the underlying Post is mutated, the re-sourced
// cache entry currently serves the raw Post record rather than re-rendering
// through here — see the PR notes and the `test.todo` in
// integrationTests/app.test.ts. Fresh renders and the UncachedBlog path are
// correct.
class PageBuilder extends tables.Post {
	static async get(target) {
		return renderPostResponse(target);
	}
}

tables.BlogCache.sourcedFrom(PageBuilder);

// CachedBlog serves the cached page directly: the cached record already holds
// the rendered HTML body and its Content-Type (from the PageBuilder source
// response above), so no custom get() is needed.
export class CachedBlog extends tables.BlogCache {}
