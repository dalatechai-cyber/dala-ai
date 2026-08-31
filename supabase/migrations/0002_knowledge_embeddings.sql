-- P2. Applied when retrieval is switched on for the first tenant, not at launch.
--
-- Split from 0001 deliberately: creating the extension conditionally would make the
-- schema DIFFER between environments, which is the drift the canonical schema exists
-- to prevent. Either an environment has this migration or it does not.
--
-- Retrieval is switched on per tenant by the named triggers (T1 size, T2 dollar,
-- T3 quality) against tenants.kb_inline_token_budget. Shipping the chokepoint in
-- 0001 without embeddings is the point: app.search_kb() exists from day one so that
-- nobody writes `order by embedding <=> $1` by hand outside a tenant scope.

create extension if not exists vector;

alter table knowledge_chunks
  add column embedding vector(1536);

-- Partial: only rows that actually carry an embedding enter the index.
create index knowledge_chunks_embedding
  on knowledge_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- The vector index is the one place the composite-FK spine cannot reach: an ANN
-- search is not a join and carries no tenant predicate of its own. app.search_kb()
-- is therefore the ONLY sanctioned path, and it filters on tenant_id before the
-- distance operator ever runs. A CI grep guards against a hand-rolled query.
