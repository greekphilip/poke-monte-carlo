const DATABASE_NAME = "pokemon-monte-carlo";
const SUITE_STORE_NAME = "suites";
const DATASET_STORE_NAME = "datasets";
const PORTFOLIO_STORE_NAME = "portfolios";
const DATABASE_VERSION = 3;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SUITE_STORE_NAME)) {
        database.createObjectStore(SUITE_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(DATASET_STORE_NAME)) {
        database.createObjectStore(DATASET_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PORTFOLIO_STORE_NAME)) {
        database.createObjectStore(PORTFOLIO_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, action) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export function saveSuite(suite) {
  return withStore(SUITE_STORE_NAME, "readwrite", (store) => store.put(suite));
}

export function getSuite(id) {
  return withStore(SUITE_STORE_NAME, "readonly", (store) => store.get(id));
}

export function deleteSuite(id) {
  return withStore(SUITE_STORE_NAME, "readwrite", (store) => store.delete(id));
}

export async function listSuites() {
  const suites = await withStore(SUITE_STORE_NAME, "readonly", (store) => store.getAll());
  return suites
    .map(({ id, name, createdAt, updatedAt, datasetFingerprint, results, simulations }) => ({
      id,
      name,
      createdAt,
      updatedAt,
      datasetFingerprint,
      simulations,
      scenarioCount: results?.length || 0
    }))
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
}

export function saveDatasetDraft(draft) {
  return withStore(DATASET_STORE_NAME, "readwrite", (store) =>
    store.put({ ...draft, id: "active" })
  );
}

export function getDatasetDraft() {
  return withStore(DATASET_STORE_NAME, "readonly", (store) =>
    store.get("active")
  );
}

export function deleteDatasetDraft() {
  return withStore(DATASET_STORE_NAME, "readwrite", (store) =>
    store.delete("active")
  );
}

export function savePortfolio(portfolio) {
  return withStore(PORTFOLIO_STORE_NAME, "readwrite", (store) =>
    store.put({ ...portfolio, id: "active" })
  );
}

export function getPortfolio() {
  return withStore(PORTFOLIO_STORE_NAME, "readonly", (store) =>
    store.get("active")
  );
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodePortable(value) {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return {
      __typedArray: value.constructor.name,
      data: bytesToBase64(bytes)
    };
  }
  if (Array.isArray(value)) return value.map(encodePortable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodePortable(child)])
    );
  }
  return value;
}

export function decodePortable(value) {
  if (value && value.__typedArray) {
    const constructors = {
      Uint8Array,
      Uint32Array,
      Float64Array
    };
    const Constructor = constructors[value.__typedArray];
    if (!Constructor) throw new Error(`Unsupported array type: ${value.__typedArray}`);
    const bytes = base64ToBytes(value.data);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Constructor(buffer);
  }
  if (Array.isArray(value)) return value.map(decodePortable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodePortable(child)])
    );
  }
  return value;
}

export async function suiteToBlob(suite) {
  const json = JSON.stringify(encodePortable(suite));
  if (typeof CompressionStream === "undefined") {
    return new Blob([json], { type: "application/json" });
  }
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).arrayBuffer()], { type: "application/gzip" });
}

export async function suiteFromFile(file) {
  let text;
  if (file.name.endsWith(".gz") && typeof DecompressionStream !== "undefined") {
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else {
    text = await file.text();
  }
  return decodePortable(JSON.parse(text));
}

export function validateSuite(suite, expectedSchemaVersion, currentDatasetFingerprint = "") {
  if (!suite || typeof suite !== "object" || !suite.id || !Array.isArray(suite.results)) {
    throw new Error("This is not a valid scenario suite.");
  }
  if (suite.schemaVersion !== expectedSchemaVersion) {
    throw new Error("This saved suite uses an unsupported schema version.");
  }
  return {
    datasetMismatch: Boolean(
      currentDatasetFingerprint &&
      suite.datasetFingerprint &&
      currentDatasetFingerprint !== suite.datasetFingerprint
    )
  };
}
