import { randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";

export type PageStatus = "generating" | "ready" | "failed";

export interface Page {
  id: string;
  slug: string;
  title: string;
  brief: string;
  status: PageStatus;
  html: string | null;
  error: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PageResponse {
  id: number;
  data: Record<string, unknown>;
  createdAt: string;
}

interface PageRow {
  id: string;
  slug: string;
  title: string;
  brief: string;
  status: PageStatus;
  html: string | null;
  error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function toPage(row: PageRow): Page {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    brief: row.brief,
    status: row.status,
    html: row.html,
    error: row.error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Pages the assistant published and the answers people sent through them. */
export class PageStore {
  constructor(private readonly db: Db) {}

  create(input: { slug: string; title: string; brief: string }, now: Date): Page {
    const id = randomUUID();
    const at = now.toISOString();
    this.db
      .prepare("INSERT INTO pages (id, slug, title, brief, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'generating', ?, ?)")
      .run(id, input.slug, input.title, input.brief, at, at);
    return this.require(input.slug);
  }

  get(slug: string): Page | undefined {
    const row = this.db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as PageRow | undefined;
    return row ? toPage(row) : undefined;
  }

  require(slug: string): Page {
    const page = this.get(slug);
    if (!page) throw new Error(`page ${slug} not found`);
    return page;
  }

  list(limit: number): (Page & { responses: number })[] {
    const rows = this.db
      .prepare("SELECT p.*, (SELECT COUNT(*) FROM page_responses r WHERE r.page_id = p.id) AS responses FROM pages p ORDER BY p.updated_at DESC LIMIT ?")
      .all(limit) as (PageRow & { responses: number })[];
    return rows.map((row) => ({ ...toPage(row), responses: row.responses }));
  }

  markGenerating(id: string, now: Date): void {
    this.db.prepare("UPDATE pages SET status = 'generating', error = NULL, updated_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  publish(id: string, html: string, now: Date): void {
    this.db.prepare("UPDATE pages SET status = 'ready', html = ?, error = NULL, version = version + 1, updated_at = ? WHERE id = ?").run(html, now.toISOString(), id);
  }

  /** A failed generation keeps the last published version online when there is one. */
  fail(id: string, error: string, now: Date): void {
    this.db
      .prepare("UPDATE pages SET status = CASE WHEN html IS NULL THEN 'failed' ELSE 'ready' END, error = ?, updated_at = ? WHERE id = ?")
      .run(error.slice(0, 500), now.toISOString(), id);
  }

  addResponse(pageId: string, data: Record<string, unknown>, now: Date): { id: number; total: number } {
    const id = Number(
      this.db.prepare("INSERT INTO page_responses (page_id, data_json, created_at) VALUES (?, ?, ?)").run(pageId, JSON.stringify(data), now.toISOString()).lastInsertRowid,
    );
    return { id, total: this.responseCount(pageId) };
  }

  responseCount(pageId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM page_responses WHERE page_id = ?").get(pageId) as { n: number }).n;
  }

  responses(pageId: string, limit: number): PageResponse[] {
    const rows = this.db
      .prepare("SELECT id, data_json, created_at FROM page_responses WHERE page_id = ? ORDER BY id DESC LIMIT ?")
      .all(pageId, limit) as { id: number; data_json: string; created_at: string }[];
    return rows.map((row) => ({ id: row.id, data: JSON.parse(row.data_json) as Record<string, unknown>, createdAt: row.created_at }));
  }
}
