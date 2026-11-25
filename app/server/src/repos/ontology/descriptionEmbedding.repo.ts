// Data access for ontology.description_embeddings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  descriptionEmbeddingTable,
  type DescriptionEmbedding,
  type DescriptionEmbeddingChanges,
  type NewDescriptionEmbedding,
} from '../../models/ontology/descriptionEmbedding.model.ts';

export const descriptionEmbeddingRepo = {
  insert(db: Queryable, row: NewDescriptionEmbedding): Promise<DescriptionEmbedding> {
    return insertRow(db, descriptionEmbeddingTable, row);
  },

  findById(db: Queryable, id: DescriptionEmbedding['id']): Promise<DescriptionEmbedding | undefined> {
    return findRow(db, descriptionEmbeddingTable, { id });
  },

  findByKindAndElementId(
    db: Queryable,
    key: Pick<DescriptionEmbedding, 'organisationId' | 'kind' | 'elementId'>,
  ): Promise<DescriptionEmbedding | undefined> {
    return findRow(db, descriptionEmbeddingTable, key);
  },

  update(
    db: Queryable,
    id: DescriptionEmbedding['id'],
    changes: DescriptionEmbeddingChanges,
  ): Promise<DescriptionEmbedding | undefined> {
    return updateRow(db, descriptionEmbeddingTable, { id }, changes);
  },

  remove(db: Queryable, id: DescriptionEmbedding['id']): Promise<boolean> {
    return deleteRow(db, descriptionEmbeddingTable, { id });
  },

  /** What is embedded, and the hash of each text: what a refresh compares main against. */
  async hashes(db: Queryable): Promise<{ kind: 'object_type' | 'property' | 'link_type'; elementId: string; textHash: string }[]> {
    const { rows } = await db.query('select kind, element_id as "elementId", text_hash as "textHash" from ontology.description_embeddings');
    return rows as { kind: 'object_type' | 'property' | 'link_type'; elementId: string; textHash: string }[];
  },

  /** An element's embedding, replacing the one it had. */
  async put(db: Queryable, row: {
    id: string; organisationId: string; kind: 'object_type' | 'property' | 'link_type'; elementId: string; objectTypeId: string;
    otherObjectTypeId: string | null; textHash: string; embedding: readonly number[]; model: string;
  }): Promise<void> {
    await db.query(
      `insert into ontology.description_embeddings (id, organisation_id, kind, element_id, object_type_id, other_object_type_id, text_hash, embedding, model)
       values ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)
       on conflict (organisation_id, kind, element_id) do update set object_type_id = excluded.object_type_id,
         other_object_type_id = excluded.other_object_type_id, text_hash = excluded.text_hash, embedding = excluded.embedding,
         model = excluded.model, embedded_at = now()`,
      [row.id, row.organisationId, row.kind, row.elementId, row.objectTypeId, row.otherObjectTypeId, row.textHash, `[${row.embedding.join(',')}]`, row.model]);
  },

  /** Embeddings of elements main no longer holds. */
  async removeElements(db: Queryable, elements: readonly { kind: string; elementId: string }[]): Promise<number> {
    if (elements.length === 0) return 0;
    const { rowCount } = await db.query(
      `delete from ontology.description_embeddings d using unnest($1::text[], $2::uuid[]) as gone(kind, element_id)
       where d.kind = gone.kind and d.element_id = gone.element_id`,
      [elements.map((e) => e.kind), elements.map((e) => e.elementId)]);
    return rowCount ?? 0;
  },

  /** Each embedding touching these types (a type's, its properties', its links'), with its cosine similarity to the vector. */
  async similarTo(db: Queryable, vector: readonly number[], objectTypeIds: readonly string[])
    : Promise<{ kind: 'object_type' | 'property' | 'link_type'; objectTypeId: string; otherObjectTypeId: string | null; similarity: number }[]> {
    if (objectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select kind, object_type_id as "objectTypeId", other_object_type_id as "otherObjectTypeId",
              1 - (embedding <=> $1::vector) as similarity
       from ontology.description_embeddings
       where object_type_id = any($2::uuid[]) or other_object_type_id = any($2::uuid[])`,
      [`[${vector.join(',')}]`, objectTypeIds]);
    return (rows as { kind: 'object_type' | 'property' | 'link_type'; objectTypeId: string; otherObjectTypeId: string | null; similarity: number | string }[])
      .map((r) => ({ ...r, similarity: Number(r.similarity) }));
  },
};
