const DB_NAME = "telemetry-tracker-db";
const DB_VERSION = 2;
const RUN_STORE = "runs";
const TRACK_STORE = "tracks";
const CHUNK_STORE = "chunks";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RUN_STORE)) {
        const store = database.createObjectStore(RUN_STORE, { keyPath: "id" });
        store.createIndex("date", "date");
      }
      if (!database.objectStoreNames.contains(TRACK_STORE)) {
        database.createObjectStore(TRACK_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const store = database.createObjectStore(CHUNK_STORE, { keyPath: ["runId", "seq"] });
        store.createIndex("runId", "runId");
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class RunStorage {
  constructor() {
    this.dbPromise = openDatabase();
  }

  async put(storeName, value) {
    const db = await this.dbPromise;
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
    return value;
  }

  async getAll(storeName) {
    const db = await this.dbPromise;
    return requestToPromise(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
  }

  async remove(storeName, key) {
    const db = await this.dbPromise;
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
  }

  saveRun(run) {
    return this.put(RUN_STORE, run);
  }

  async getRuns() {
    const runs = await this.getAll(RUN_STORE);
    return runs.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  async getRun(id) {
    const db = await this.dbPromise;
    return requestToPromise(db.transaction(RUN_STORE, "readonly").objectStore(RUN_STORE).get(id));
  }

  async deleteRun(id) {
    await this.remove(RUN_STORE, id);
    await this.deleteChunks(id);
  }

  saveTrack(track) {
    return this.put(TRACK_STORE, track);
  }

  async getTracks() {
    const tracks = await this.getAll(TRACK_STORE);
    return tracks.sort((a, b) => a.name.localeCompare(b.name));
  }

  deleteTrack(id) {
    return this.remove(TRACK_STORE, id);
  }

  appendChunk(runId, seq, chunk) {
    return this.put(CHUNK_STORE, { runId, seq, gnss: chunk.gnss, imu: chunk.imu });
  }

  async getChunks(runId) {
    const db = await this.dbPromise;
    const index = db.transaction(CHUNK_STORE, "readonly").objectStore(CHUNK_STORE).index("runId");
    const chunks = await requestToPromise(index.getAll(runId));
    return chunks.sort((a, b) => a.seq - b.seq);
  }

  async deleteChunks(runId) {
    const db = await this.dbPromise;
    const transaction = db.transaction(CHUNK_STORE, "readwrite");
    const index = transaction.objectStore(CHUNK_STORE).index("runId");
    const keys = await requestToPromise(index.getAllKeys(runId));
    for (const key of keys) {
      transaction.objectStore(CHUNK_STORE).delete(key);
    }
    await transactionDone(transaction);
  }

  // Rebuilds runs that were still recording when the app was killed.
  async recoverInterruptedRuns() {
    const runs = await this.getAll(RUN_STORE);
    const recovered = [];
    for (const run of runs.filter((item) => item.status === "recording")) {
      const chunks = await this.getChunks(run.id);
      const gnss = chunks.flatMap((chunk) => chunk.gnss);
      const imu = chunks.flatMap((chunk) => chunk.imu);
      if (!gnss.length && !imu.length) {
        await this.deleteRun(run.id);
        continue;
      }
      const lastT = Math.max(gnss[gnss.length - 1]?.t ?? 0, imu[imu.length - 1]?.t ?? 0);
      recovered.push({
        ...run,
        status: "recovered",
        gnss,
        imu,
        duration: Math.max(0, lastT - run.startedAt),
      });
    }
    return recovered;
  }
}
