export interface LocalSegment {
  id: string;
  meetingId: string;
  sequence: number;
  createdAt: number;
  durationMs: number;
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

      request.onsuccess = () => resolve(request.result.sort((a, b) => a.sequence - b.sequence));
      request.onerror = () => reject(request.error ?? new Error("Lokale segmenten konden niet worden gelezen."));
    });
  }

  async put(segment: LocalSegment): Promise<void> {
    const database = await this.open();

    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(storeName, "readwrite")
        .objectStore(storeName)
        .put(segment);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Audiosegment kon niet lokaal worden opgeslagen."));
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
