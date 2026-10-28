export interface LocalSegment {
  id: string;
  meetingId: string;
  sequence: number;
  createdAt: number;
  durationMs: number;
  startMs?: number;
  blob: Blob;
  transcriptionStatus?: "pending" | "processing" | "completed" | "failed";
  transcriptionError?: string;
}

export interface SegmentStore {
  list(meetingId: string): Promise<LocalSegment[]>;
  put(segment: LocalSegment): Promise<void>;
}

const databaseName = "ai-vergadersecretaris";
const storeName = "recording-segments";

export class IndexedDbSegmentStore implements SegmentStore {
  async list(meetingId: string): Promise<LocalSegment[]> {
    const database = await this.open();

    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly")
        .objectStore(storeName)
        .index("meetingId")
        .getAll(meetingId);

      request.onsuccess = () => { database.close(); resolve(request.result.sort((a, b) => a.sequence - b.sequence)); };
      request.onerror = () => reject(request.error ?? new Error("Lokale segmenten konden niet worden gelezen."));
    });
  }

  async put(segment: LocalSegment): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(segment);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Audiosegment kon niet lokaal worden opgeslagen.")); };
    });
  }

  async meetings(): Promise<Array<{ id: string; startedAt: number; count: number }>> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => {
        const meetings = new Map<string, { id: string; startedAt: number; count: number }>();
        for (const segment of request.result as LocalSegment[]) {
          const previous = meetings.get(segment.meetingId);
          meetings.set(segment.meetingId, { id: segment.meetingId, startedAt: Math.min(previous?.startedAt ?? Infinity, segment.createdAt), count: (previous?.count ?? 0) + 1 });
        }
        database.close(); resolve([...meetings.values()].sort((a,b) => b.startedAt - a.startedAt));
      };
      request.onerror = () => { database.close(); reject(request.error); };
    });
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("Lokale opslag is niet beschikbaar in deze browser."));
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);

      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.createObjectStore(storeName, { keyPath: "id" });
        store.createIndex("meetingId", "meetingId", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Lokale opslag kon niet worden geopend."));
    });
  }
}
