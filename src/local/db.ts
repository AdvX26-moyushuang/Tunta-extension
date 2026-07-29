/**
 * 兼容层：仅保留 re-export，让现有 import 路径不断。
 * Task 0.2 会把所有调用点改成 getStore()，然后删除本文件。
 */
import { getStore } from "./store";
import type {
  StoredCapture,
  StoredCard,
  StoredChatTurn,
  StoredDocument,
  StoredKaleidoscopeEdge,
} from "./store/types";

export { kaleidoscopeEdgeId } from "./store/types";
export type {
  StoredCapture,
  StoredCard,
  StoredChatTurn,
  StoredDocument,
  StoredKaleidoscopeEdge,
} from "./store/types";

// captures

export function putCapture(capture: StoredCapture): Promise<StoredCapture> {
  return getStore().putCapture(capture);
}

export function getCapture(captureId: string): Promise<StoredCapture | undefined> {
  return getStore().getCapture(captureId);
}

export function getCaptureByUrl(url: string): Promise<StoredCapture | undefined> {
  return getStore().getCaptureByUrl(url);
}

export function listCaptures(): Promise<StoredCapture[]> {
  return getStore().listCaptures();
}

// documents

export function putDocument(doc: StoredDocument): Promise<StoredDocument> {
  return getStore().putDocument(doc);
}

export function getDocument(sourceId: string): Promise<StoredDocument | undefined> {
  return getStore().getDocument(sourceId);
}

export function listDocuments(): Promise<StoredDocument[]> {
  return getStore().listDocuments();
}

// cards

export function putCards(cards: StoredCard[]): Promise<void> {
  return getStore().putCards(cards);
}

export function replaceCardsForSource(sourceId: string, cards: StoredCard[]): Promise<void> {
  return getStore().replaceCardsForSource(sourceId, cards);
}

export function putCard(card: StoredCard): Promise<StoredCard> {
  return getStore().putCard(card);
}

export function listCards(): Promise<StoredCard[]> {
  return getStore().listCards();
}

export function listCardsBySource(sourceId: string): Promise<StoredCard[]> {
  return getStore().listCardsBySource(sourceId);
}

// history

export function putChatTurn(record: StoredChatTurn): Promise<StoredChatTurn> {
  return getStore().putChatTurn(record);
}

export function getChatTurnRecord(queryId: string): Promise<StoredChatTurn | undefined> {
  return getStore().getChatTurnRecord(queryId);
}

export function listChatTurns(): Promise<StoredChatTurn[]> {
  return getStore().listChatTurns();
}

export function pruneChatTurns(keep?: number): Promise<void> {
  return getStore().pruneChatTurns(keep);
}

// kaleidoscope edges

export function putKaleidoscopeEdges(edges: StoredKaleidoscopeEdge[]): Promise<void> {
  return getStore().putKaleidoscopeEdges(edges);
}

export function listKaleidoscopeEdges(): Promise<StoredKaleidoscopeEdge[]> {
  return getStore().listKaleidoscopeEdges();
}

export function clearKaleidoscopeEdges(): Promise<void> {
  return getStore().clearKaleidoscopeEdges();
}

export function deleteKaleidoscopeEdgesForSource(sourceId: string): Promise<void> {
  return getStore().deleteKaleidoscopeEdgesForSource(sourceId);
}

export function clearAllLocalData(): Promise<void> {
  return getStore().clearAllLocalData();
}
