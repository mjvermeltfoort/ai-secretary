import type { MeetingCheckpoint, CheckpointStore } from "./meetingCheckpoint";
export interface LocalSegment {
  id: string;
  meetingId: string;
  sequence: number;
  createdAt: number;
  durationMs: number;
  startMs?: number;
  blob: Blob;
  checksum?: string;
  transcriptionStatus?: "pending" | "processing" | "completed" | "failed";
  transcriptionError?: string;
}

export interface SegmentStore {
  list(meetingId: string): Promise<LocalSegment[]>;
  put(segment: LocalSegment): Promise<void>;
  append?(segment: LocalSegment): Promise<void>;
}

const databaseName = "ai-vergadersecretaris";
const storeName = "recording-segments";

export class IndexedDbSegmentStore implements SegmentStore, CheckpointStore {
  async list(meetingId: string): Promise<LocalSegment[]> {
    const database = await this.open();

    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly")
        .objectStore(storeName)
        .index("meetingId")
        .getAll(meetingId);

      request.onsuccess = () => { database.close(); resolve(request.result.sort((a, b) => a.sequence - b.sequence)); };
      request.onerror = () => { database.close(); reject(request.error ?? new Error("Lokale segmenten konden niet worden gelezen.")); };
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

  async append(segment: LocalSegment): Promise<void> {
    const database = await this.open();
    return new Promise((resolve,reject)=>{
      const transaction=database.transaction(storeName,"readwrite");
      transaction.objectStore(storeName).add(segment);
      transaction.oncomplete=()=>{database.close();resolve();};
      transaction.onerror=transaction.onabort=()=>{database.close();reject(transaction.error??new Error("Audioblok bestaat al; bestaande audio is niet overschreven."));};
    });
  }

  async meetings(): Promise<Array<{ id: string; startedAt: number; count: number }>> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).openCursor();
      const meetings = new Map<string, { id: string; startedAt: number; count: number }>();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const segment = cursor.value as LocalSegment;
          const previous = meetings.get(segment.meetingId);
          meetings.set(segment.meetingId, { id: segment.meetingId, startedAt: Math.min(previous?.startedAt ?? Infinity, segment.createdAt), count: (previous?.count ?? 0) + 1 });
          cursor.continue();
        } else { database.close(); resolve([...meetings.values()].sort((a,b) => b.startedAt - a.startedAt)); }
      };
      request.onerror = () => { database.close(); reject(request.error); };
    });
  }

  async loadMeeting(meetingId: string): Promise<MeetingCheckpoint | undefined> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("meeting-recovery", "readonly");
      const request = transaction.objectStore("meeting-recovery").get(meetingId);
      transaction.oncomplete = () => { database.close(); resolve(request.result); };
      transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Herstelgegevens konden niet worden gelezen.")); };
    });
  }
  async saveMeeting(meetingId: string, patch: Partial<Omit<MeetingCheckpoint, "id" | "updatedAt">>): Promise<void> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("meeting-recovery", "readwrite");
      const store = transaction.objectStore("meeting-recovery");
      const request = store.get(meetingId);
      request.onsuccess = () => store.put({ ...request.result, ...patch, id: meetingId, updatedAt: Date.now() });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Herstelgegevens konden niet worden opgeslagen.")); };
    });
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("Lokale opslag is niet beschikbaar in deze browser."));
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) {
          const store = database.createObjectStore(storeName, { keyPath: "id" });
          store.createIndex("meetingId", "meetingId", { unique: false });
        }
        if (!database.objectStoreNames.contains("meeting-recovery")) database.createObjectStore("meeting-recovery", { keyPath: "id" });
      };
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(new Error("Sluit andere tabbladen van de notulist om de lokale opslag bij te werken.")); };
      request.onsuccess = () => {
        if (blocked) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("Lokale opslag kon niet worden geopend."));
    });
  }
}
