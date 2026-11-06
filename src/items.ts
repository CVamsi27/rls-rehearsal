import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { tenantTransaction } from './database.js';

export const DB = Symbol('database');

type Item = {
  id: string;
  title: string;
  status: 'open' | 'closed';
  createdAt: Date;
};

const fields = 'id, title, status, created_at AS "createdAt"';

async function getItem(tx: PoolClient, workspace: string, id: string): Promise<Item> {
  const result = await tx.query<Item>(`SELECT ${fields} FROM tenantproof.items WHERE workspace_id = $1 AND id = $2`, [workspace, id]);
  const item = result.rows[0];
  if (!item) throw new NotFoundException();
  return item;
}

@Injectable()
export class Items {
  constructor(@Inject(DB) private readonly pool: Pool) {}

  list(workspace: string) {
    return tenantTransaction(this.pool, workspace, async (tx) => {
      const result = await tx.query<Item>(
        `SELECT ${fields} FROM tenantproof.items WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
        [workspace],
      );
      return result.rows;
    });
  }

  get(workspace: string, id: string) {
    return tenantTransaction(this.pool, workspace, (tx) => getItem(tx, workspace, id));
  }

  create(workspace: string, title: string) {
    return tenantTransaction(this.pool, workspace, async (tx) => {
      const result = await tx.query<Item>(
        `INSERT INTO tenantproof.items (workspace_id, title) VALUES ($1, $2) RETURNING ${fields}`,
        [workspace, title],
      );
      return result.rows[0]!;
    });
  }

  close(workspace: string, id: string) {
    return tenantTransaction(this.pool, workspace, async (tx) => {
      const result = await tx.query<Item>(
        `UPDATE tenantproof.items SET status = 'closed' WHERE workspace_id = $1 AND id = $2 AND status = 'open' RETURNING ${fields}`,
        [workspace, id],
      );
      return result.rows[0] ?? getItem(tx, workspace, id);
    });
  }
}
