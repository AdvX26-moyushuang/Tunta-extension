import { ensureOffscreen } from "@/offscreen/host";
import { DB_RPC_TARGET, type DbMethod, type DbRpcResponse } from "@/shared/db-rpc";
import type {
  CardFtsHit,
  EmbeddingHit,
  EmbeddingModelInfo,
  StoredCapture,
  StoredCard,
  StoredChatTurn,
  StoredChunk,
  StoredDocument,
  StoredEmbedding,
  StoredEntity,
  StoredEntityEdge,
  StoredKaleidoscopeEdge,
  StoredMention,
  TuntaStore,
} from "./types";

/**
 * SW 侧的 TuntaStore 代理：每个方法一次 chrome.runtime 往返，
 * 真正的 SQL 逻辑（SqlCore）在 offscreen 的 dedicated worker 里执行。
 */
async function call<T>(method: DbMethod, args: unknown[]): Promise<T> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage({ target: DB_RPC_TARGET, method, args })) as
    | DbRpcResponse
    | undefined;
  if (!response) throw new Error(`tunta-db RPC 无响应：${method}`);
  if (!response.ok) throw new Error(response.error);
  return response.value as T;
}

export class SqliteStore implements TuntaStore {
  putCapture(capture: StoredCapture): Promise<StoredCapture> {
    return call("putCapture", [capture]);
  }

  getCapture(captureId: string): Promise<StoredCapture | undefined> {
    return call("getCapture", [captureId]);
  }

  getCaptureByUrl(url: string): Promise<StoredCapture | undefined> {
    return call("getCaptureByUrl", [url]);
  }

  listCaptures(): Promise<StoredCapture[]> {
    return call("listCaptures", []);
  }

  putDocument(doc: StoredDocument): Promise<StoredDocument> {
    return call("putDocument", [doc]);
  }

  getDocument(sourceId: string): Promise<StoredDocument | undefined> {
    return call("getDocument", [sourceId]);
  }

  listDocuments(): Promise<StoredDocument[]> {
    return call("listDocuments", []);
  }

  putCards(cards: StoredCard[]): Promise<void> {
    return call("putCards", [cards]);
  }

  replaceCardsForSource(sourceId: string, cards: StoredCard[]): Promise<void> {
    return call("replaceCardsForSource", [sourceId, cards]);
  }

  putCard(card: StoredCard): Promise<StoredCard> {
    return call("putCard", [card]);
  }

  listCards(): Promise<StoredCard[]> {
    return call("listCards", []);
  }

  listCardsBySource(sourceId: string): Promise<StoredCard[]> {
    return call("listCardsBySource", [sourceId]);
  }

  searchCardsFts(query: string, limit: number): Promise<CardFtsHit[]> {
    return call("searchCardsFts", [query, limit]);
  }

  replaceChunksForSource(sourceId: string, chunks: StoredChunk[]): Promise<void> {
    return call("replaceChunksForSource", [sourceId, chunks]);
  }

  listChunksBySource(sourceId: string): Promise<StoredChunk[]> {
    return call("listChunksBySource", [sourceId]);
  }

  putEmbeddings(embeddings: StoredEmbedding[]): Promise<void> {
    return call("putEmbeddings", [embeddings]);
  }

  searchEmbeddings(queryVector: number[], model: string, topK: number, ownerKind?: StoredEmbedding["ownerKind"]): Promise<EmbeddingHit[]> {
    return call("searchEmbeddings", ownerKind === undefined ? [queryVector, model, topK] : [queryVector, model, topK, ownerKind]);
  }

  listEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
    return call("listEmbeddingModels", []);
  }

  listEmbeddedOwnerIds(ownerKind: StoredEmbedding["ownerKind"], model: string): Promise<string[]> {
    return call("listEmbeddedOwnerIds", [ownerKind, model]);
  }

  deleteEmbeddings(ownerKind: StoredEmbedding["ownerKind"], ownerIds: string[]): Promise<void> {
    return call("deleteEmbeddings", [ownerKind, ownerIds]);
  }

  putChatTurn(record: StoredChatTurn): Promise<StoredChatTurn> {
    return call("putChatTurn", [record]);
  }

  getChatTurnRecord(queryId: string): Promise<StoredChatTurn | undefined> {
    return call("getChatTurnRecord", [queryId]);
  }

  listChatTurns(): Promise<StoredChatTurn[]> {
    return call("listChatTurns", []);
  }

  pruneChatTurns(keep?: number): Promise<void> {
    return call("pruneChatTurns", keep === undefined ? [] : [keep]);
  }

  syncEntityMentionsForSource(sourceId: string, cards: StoredCard[]): Promise<void> {
    return call("syncEntityMentionsForSource", [sourceId, cards]);
  }

  listEntities(): Promise<StoredEntity[]> {
    return call("listEntities", []);
  }

  listMentions(): Promise<StoredMention[]> {
    return call("listMentions", []);
  }

  setHubEntities(entityIds: string[]): Promise<void> {
    return call("setHubEntities", [entityIds]);
  }

  replaceEntityEdges(edges: StoredEntityEdge[]): Promise<void> {
    return call("replaceEntityEdges", [edges]);
  }

  listEntityEdges(): Promise<StoredEntityEdge[]> {
    return call("listEntityEdges", []);
  }

  putKaleidoscopeEdges(edges: StoredKaleidoscopeEdge[]): Promise<void> {
    return call("putKaleidoscopeEdges", [edges]);
  }

  listKaleidoscopeEdges(): Promise<StoredKaleidoscopeEdge[]> {
    return call("listKaleidoscopeEdges", []);
  }

  clearKaleidoscopeEdges(): Promise<void> {
    return call("clearKaleidoscopeEdges", []);
  }

  deleteKaleidoscopeEdgesForSource(sourceId: string): Promise<void> {
    return call("deleteKaleidoscopeEdgesForSource", [sourceId]);
  }

  clearAllLocalData(): Promise<void> {
    return call("clearAllLocalData", []);
  }
}
