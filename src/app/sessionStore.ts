/**
 * Where the session (the model as it is on screen, for recovery after a crash or reload) is kept:
 * the browser's IndexedDB, which holds hundreds of megabytes, rather than localStorage, which holds
 * about five and so could not keep large models. A session kept in localStorage by an earlier
 * version is still read, and removed once the session is in IndexedDB.
 */

const DB_NAME = 'archiopen'
const STORE = 'session'
const KEY = 'current'
/** Where earlier versions kept the session. */
export const LEGACY_KEY = 'archiopen:session'

let opened: Promise<IDBDatabase | null> | null = null

function database(): Promise<IDBDatabase | null> {
  opened ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      // No IndexedDB here (some private windows): localStorage only.
      resolve(null)
    }
  })
  return opened
}

function request<T>(make: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T | undefined> {
  return database().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db) return resolve(undefined)
        const tx = db.transaction(STORE, mode)
        const req = make(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(req.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Keeps the session (as text). Resolves to where it went, or null if it could not be kept. */
export async function storeSession(text: string): Promise<'indexedDB' | 'localStorage' | null> {
  try {
    if (await database()) {
      await request((store) => store.put(text, KEY), 'readwrite')
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        // Nothing to free.
      }
      return 'indexedDB'
    }
  } catch (error) {
    console.warn('Could not keep the session in IndexedDB', error)
  }
  try {
    localStorage.setItem(LEGACY_KEY, text)
    return 'localStorage'
  } catch (error) {
    console.warn('Could not keep the session', error)
    return null
  }
}

/** The session kept last, if any. */
export async function loadSession(): Promise<string | null> {
  try {
    const text = await request((store) => store.get(KEY) as IDBRequest<string | undefined>, 'readonly')
    if (typeof text === 'string') return text
  } catch (error) {
    console.warn('Could not read the session from IndexedDB', error)
  }
  try {
    return localStorage.getItem(LEGACY_KEY)
  } catch {
    return null
  }
}
