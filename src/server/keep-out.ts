import type { Pool } from 'pg';
import { IntegrationError } from './integration-connection.ts';

type Query = Pick<Pool, 'query'>;
type Column = 'local_keep_out' | 'computer_keep_out';

export async function addKeepOut(
  database: Query,
  ownerId: string,
  column: Column,
  entry: string,
  limit: number,
  noun: string,
) {
  const { rows } = await database.query<{ list: string[] }>(
    `SELECT ${column} AS list FROM preferences WHERE owner_id=$1`,
    [ownerId],
  );
  const current = rows[0]?.list ?? [];
  if (current.includes(entry)) return current;
  if (current.length >= limit)
    throw new IntegrationError(
      `The keep-out list already has ${limit} ${noun}. The owner can remove some in Settings.`,
      409,
    );
  const saved = await database.query<{ list: string[] }>(
    `INSERT INTO preferences(owner_id,${column}) VALUES($1,ARRAY[$2]::text[])
     ON CONFLICT(owner_id) DO UPDATE SET ${column}=CASE WHEN $2=ANY(preferences.${column})
       THEN preferences.${column} ELSE array_append(preferences.${column},$2) END
     RETURNING ${column} AS list`,
    [ownerId, entry],
  );
  return saved.rows[0]!.list;
}

export async function removeKeepOut(
  database: Query,
  ownerId: string,
  column: Column,
  entry: string,
) {
  const { rows } = await database.query<{ list: string[] }>(
    `UPDATE preferences SET ${column}=array_remove(${column},$2) WHERE owner_id=$1 RETURNING ${column} AS list`,
    [ownerId, entry],
  );
  return rows[0]?.list ?? [];
}
