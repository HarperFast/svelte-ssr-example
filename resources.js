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
		.replace(`<!--app-data-->`, `<script>window.__INITIAL_POST_DATA__ = ${JSON.stringify(post)};</script>`);

	return html;
}

export class UncachedBlog extends tables.Post {
	static async get(target) {
		const post = await tables.Post.get(target);
		return {
			status: 200,
			headers: { 'Content-Type': 'text/html' },
			body: await renderPost(post),
		};
	}
}

class PageBuilder extends tables.Post {
	static async get(target) {
		const post = await tables.Post.get(target);
		// Return a full HTTP response descriptor. Harper's caching layer parses
		// a sourced `{ status, headers, body }` response, stores the body (with
		// its Content-Type) in the cache table, and serves it on cache hits.
		return {
			status: 200,
			headers: { 'Content-Type': 'text/html' },
			body: await renderPost(post),
		};
	}
}

tables.BlogCache.sourcedFrom(PageBuilder);

// CachedBlog serves the cached page directly. The cached record already
// carries the rendered HTML body and its Content-Type (populated from the
// PageBuilder source response above), so Harper serves it with the correct
// headers and handles conditional-request revalidation (ETag / 304).
export class CachedBlog extends tables.BlogCache {}
