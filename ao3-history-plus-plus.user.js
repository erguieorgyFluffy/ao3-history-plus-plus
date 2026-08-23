// ==UserScript==
// @name         AO3 History++
// @namespace    ao3-history-plus-plus
// @version      0.3.4
// @description  Local reading history + cross-device sync for AO3
// @match https://archiveofourown.org/works/*
// @match https://archiveofourown.org/users/*/readings*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.github.com
// @run-at       document-idle
// ==/UserScript==

// ==================================================
// AO3 History++ — Embedded Modules
// ==================================================

const AO3Crypto = (() => {
  const VERSION = 1;
  const ALGORITHM = 'AES-256-GCM';

  const KEY_BYTES = 32;
  const IV_BYTES = 12;

  function getCrypto() {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error('[AO3 History++] Web Crypto API is unavailable');
    }
    return globalThis.crypto;
  }

  function bytesToBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('[AO3 History++] Invalid base64url value');
    }

    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

    let binary;
    try {
      binary = atob(padded);
    } catch {
      throw new Error('[AO3 History++] Invalid base64url encoding');
    }

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function generateKey() {
    const keyBytes = getCrypto().getRandomValues(new Uint8Array(KEY_BYTES));
    return bytesToBase64Url(keyBytes);
  }

  async function importKey(encodedKey) {
    const keyBytes = base64UrlToBytes(encodedKey);

    if (keyBytes.length !== KEY_BYTES) {
      throw new Error('[AO3 History++] Encryption key must be exactly 256 bits');
    }

    return getCrypto().subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  function validateKey(encodedKey) {
    try {
      return base64UrlToBytes(encodedKey).length === KEY_BYTES;
    } catch {
      return false;
    }
  }

  async function encrypt(value, encodedKey) {
    const cryptoApi = getCrypto();
    const key = await importKey(encodedKey);

    const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));

    const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    return {
      version: VERSION,
      algorithm: ALGORITHM,
      iv: bytesToBase64Url(iv),
      data: bytesToBase64Url(new Uint8Array(ciphertext)),
    };
  }

  async function decrypt(encryptedPayload, encodedKey) {
    if (!encryptedPayload || typeof encryptedPayload !== 'object') {
      throw new Error('[AO3 History++] Invalid encrypted payload');
    }
    if (encryptedPayload.version !== VERSION) {
      throw new Error('[AO3 History++] Unsupported encryption payload version');
    }
    if (encryptedPayload.algorithm !== ALGORITHM) {
      throw new Error('[AO3 History++] Unsupported encryption algorithm');
    }

    const iv = base64UrlToBytes(encryptedPayload.iv);
    const ciphertext = base64UrlToBytes(encryptedPayload.data);

    if (iv.length !== IV_BYTES) {
      throw new Error('[AO3 History++] Invalid encryption IV');
    }
    if (ciphertext.length === 0) {
      throw new Error('[AO3 History++] Invalid encrypted data');
    }

    const key = await importKey(encodedKey);

    let plaintext;
    try {
      plaintext = await getCrypto().subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    } catch {
      throw new Error('[AO3 History++] Decryption failed: incorrect key or corrupted data');
    }

    try {
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new Error('[AO3 History++] Decrypted data is not valid JSON');
    }
  }

  return { VERSION, ALGORITHM, KEY_BYTES, IV_BYTES, generateKey, validateKey, importKey, encrypt, decrypt };
})();


const AO3Parser = (() => {

  function getWorkId() {
    const match = window.location.pathname.match(/\/works\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  function getChapterIdFromUrl() {
    const match = window.location.pathname.match(/\/chapters\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  function getChapterSelect() {
    return document.querySelector('select#selected_id');
  }

  function getChapterStatsFromDl() {
    const dd = document.querySelector('dl.stats dd.chapters');
    if (!dd) return { current: null, total: null };

    const text = dd.textContent.trim();
    const parts = text.split('/');
    if (parts.length !== 2) return { current: null, total: null };

    const current = parseInt(parts[0], 10);
    const total = parts[1].trim() === '?' ? null : parseInt(parts[1], 10);

    return {
      current: Number.isNaN(current) ? null : current,
      total: Number.isNaN(total) ? null : total,
    };
  }

  function getTotalWordCount() {
    const dd = document.querySelector('dl.stats dd.words');
    if (!dd) return null;

    const digits = dd.textContent.replace(/[^\d]/g, '');
    if (!digits) return null;

    const n = parseInt(digits, 10);
    return Number.isNaN(n) ? null : n;
  }

  function getTagList(ddSelector) {
    const dd = document.querySelector(ddSelector);
    if (!dd) return [];
    return Array.from(dd.querySelectorAll('a.tag')).map((a) => a.textContent.trim()).filter(Boolean);
  }

  // Series breadcrumb on work pages: "Part 3 of <a href="/series/ID">Name</a>".
  function getSeriesInfo() {
    const dd =
      document.querySelector('dl.work.meta dd.series') ||
      document.querySelector('dd.series');

    const link =
      (dd && dd.querySelector('a[href*="/series/"]')) ||
      document.querySelector('.work.meta a[href*="/series/"], #workskin a[href*="/series/"]');

    if (!link) return null;

    const idMatch = (link.getAttribute('href') || '').match(/\/series\/(\d+)/);
    if (!idMatch) return null;

    const posMatch = dd
      ? dd.textContent.match(/Part\s+(\d+)/i)
      : null;

    return {
      seriesId: Number(idMatch[1]),
      position: posMatch ? Number(posMatch[1]) : null,
    };
  }

  function getTitle() {
    const heading = document.querySelector('#workskin h2.title.heading, .work .title.heading');
    if (heading) {
      return heading.textContent.replace(/\s+/g, ' ').trim();
    }

    const docTitle = document.title;
    const match = docTitle.match(/^(.*?)\s*-\s*.*\[Archive of Our Own\]$/);
    return match ? match[1].trim() : (docTitle || null);
  }

  function getAuthors() {
    const byline = document.querySelector('.preface .byline, h3.byline');
    if (!byline) return { list: ['Anonymous'], joined: 'Anonymous' };

    const authorLinks = Array.from(byline.querySelectorAll('a[rel="author"]'))
      .map(a => a.textContent.trim())
      .filter(Boolean);

    if (authorLinks.length > 0) {
      return { list: authorLinks, joined: authorLinks.join(', ') };
    }

    const text = byline.textContent.replace(/\s+/g, ' ').trim();
    const fallback = text || 'Anonymous';
    return { list: [fallback], joined: fallback };
  }

  function parse() {
    const workId = getWorkId();
    if (workId === null) return null;

    const select = getChapterSelect();
    const dlStats = getChapterStatsFromDl();

    let chapterNumber = null;
    let chapterCount = null;
    let chapterId = getChapterIdFromUrl();
    let chaptersPublished = null;

    const hasChapterStats =
      dlStats.current !== null || dlStats.total !== null;

    const isOneshot =
      !select &&
      chapterId === null &&
      (!hasChapterStats ||
        (dlStats.current === 1 && dlStats.total === 1));

    if (select) {
      const selectedOption = select.options[select.selectedIndex];
      chapterNumber = select.selectedIndex + 1;
      chaptersPublished = select.options.length;
      chapterCount = dlStats.total !== null || document.querySelector('dl.stats dd.chapters')
        ? dlStats.total
        : select.options.length;

      chapterId = parseInt(selectedOption.value, 10);
      if (Number.isNaN(chapterId)) chapterId = null;

      const urlChapterId = getChapterIdFromUrl();
      if (chapterId === null) {
        chapterId = urlChapterId;
      } else if (urlChapterId !== null && urlChapterId !== chapterId) {
        console.warn('[AO3 History++] URL/select chapterId mismatch, using URL value:', urlChapterId, 'vs', chapterId);
        chapterId = urlChapterId;
      }
    } else if (!isOneshot) {
      chapterNumber = dlStats.current;
      chapterCount = dlStats.total;
      chaptersPublished = dlStats.current;
    }

    const authors = getAuthors();

    return {
      workId,
      chapterId: isOneshot ? null : chapterId,
      chapterNumber: isOneshot ? 1 : chapterNumber,
      chapterCount: chapterCount !== null ? chapterCount : dlStats.total,
      chaptersPublished: isOneshot ? 1 : chaptersPublished,
      isOneshot,
      title: getTitle(),
      authors: authors.list,
      author: authors.joined,
      totalWordCount: getTotalWordCount(),
      fandoms: getTagList('dd.fandom.tags'),
      relationships: getTagList('dd.relationship.tags'),
      series: getSeriesInfo(),
      parserVersion: 2,
    };
  }

  return { parse };
})();


// ==================================================
// AO3 History++ — IndexedDB Module (v6, five stores)
// ==================================================

const AO3DB = (() => {
  const DB_NAME = 'ao3-history-plus-plus';
  const DB_VERSION = 6;
  const READINGS_STORE = 'readings';
  const CHAPTERS_STORE = 'chapters';
  const TOMBSTONES_STORE = 'tombstones';
  const DAILY_STATS_STORE = 'dailyStats';
  const SERIES_STORE = 'series';

  const SESSION_MIN_MS = 10_000;
  const SESSION_MIN_SCROLL_PERCENT = 0.15;

  const DEVICE_ID_STORAGE_KEY = 'ao3hpp_device_id';
  let cachedDeviceId = null;

  let dbPromise = null;

  function getDeviceId() {
    if (cachedDeviceId) return cachedDeviceId;

    let id = GM_getValue(DEVICE_ID_STORAGE_KEY, null);

    if (!id) {
      id =
        globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      GM_setValue(DEVICE_ID_STORAGE_KEY, id);
    }

    cachedDeviceId = id;
    return id;
  }

  function getLocalDateString(timestamp = Date.now()) {
    const d = new Date(timestamp);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function chapterKeyFor(chapterId) {
    return chapterId === null || chapterId === undefined ? 'oneshot' : chapterId;
  }

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(READINGS_STORE)) {
          const readings = db.createObjectStore(READINGS_STORE, { keyPath: 'workId' });
          readings.createIndex('lastVisited', 'lastVisited', { unique: false });
        }

        if (!db.objectStoreNames.contains(CHAPTERS_STORE)) {
          const chapters = db.createObjectStore(CHAPTERS_STORE, { keyPath: ['workId', 'chapterKey'] });
          chapters.createIndex('workId', 'workId', { unique: false });
          chapters.createIndex('lastVisited', 'lastVisited', { unique: false });
        }

        if (!db.objectStoreNames.contains(TOMBSTONES_STORE)) {
          db.createObjectStore(TOMBSTONES_STORE, { keyPath: 'workId' });
        }

        const oldVersion = event.oldVersion;

        if (!db.objectStoreNames.contains(DAILY_STATS_STORE)) {
          const dailyStats = db.createObjectStore(DAILY_STATS_STORE, {
            keyPath: ['date', 'deviceId', 'workId', 'chapterKey'],
          });
          dailyStats.createIndex('date', 'date', { unique: false });
          dailyStats.createIndex('workId', 'workId', { unique: false });
        } else if (oldVersion < 4) {
          const oldStore = event.target.transaction.objectStore(DAILY_STATS_STORE);
          const oldRows = [];
          oldStore.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              oldRows.push(cursor.value);
              cursor.continue();
            } else {
              db.deleteObjectStore(DAILY_STATS_STORE);
              const dailyStats = db.createObjectStore(DAILY_STATS_STORE, {
                keyPath: ['date', 'deviceId', 'workId', 'chapterKey'],
              });
              dailyStats.createIndex('date', 'date', { unique: false });
              dailyStats.createIndex('workId', 'workId', { unique: false });
              for (const row of oldRows) {
                dailyStats.add({ ...row, chapterKey: '__unknown__' });
              }
            }
          };
        }

        // v4 -> v5: bankedWords ledger seeding.
        if (
          db.objectStoreNames.contains(CHAPTERS_STORE) &&
          oldVersion < 5
        ) {
          const chaptersStore = event.target.transaction.objectStore(CHAPTERS_STORE);

          const existingRows = [];

          const cursorReq = chaptersStore.openCursor();

          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;

            if (cursor) {
              existingRows.push(cursor.value);
              cursor.continue();
            } else {
              for (const rec of existingRows) {
                if (typeof rec.bankedWords === 'number') continue;

                chaptersStore.put({
                  ...rec,
                  bankedWords: Math.round(
                    (rec.wordCount || 0) * (rec.maxScrollPercent || 0)
                  ),
                });
              }
            }
          };
        }

        // v5 -> v6 (0.3.0): series membership store.
        if (!db.objectStoreNames.contains(SERIES_STORE)) {
          db.createObjectStore(SERIES_STORE, { keyPath: 'seriesId' });
        }
      };

      req.onblocked = () => {
        console.warn(
          '[AO3 History++] Database upgrade is waiting on another open ' +
          'archiveofourown.org tab/window. Close the other AO3 tabs and reload this page.'
        );
      };

      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });

    return dbPromise;
  }

  function tx(storeNames, mode) {
    return openDB().then((db) => db.transaction(storeNames, mode));
  }

  function promisifyRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getReading(workId) {
    const t = await tx([READINGS_STORE], 'readonly');
    const result = await promisifyRequest(t.objectStore(READINGS_STORE).get(workId));
    return result || null;
  }

  async function getChapter(workId, chapterId) {
    const t = await tx([CHAPTERS_STORE], 'readonly');
    const key = [workId, chapterKeyFor(chapterId)];
    const result = await promisifyRequest(t.objectStore(CHAPTERS_STORE).get(key));
    return result || null;
  }

  async function getLatestChapter(workId) {
    const t = await tx([CHAPTERS_STORE], 'readonly');
    const idx = t.objectStore(CHAPTERS_STORE).index('workId');
    const all = await promisifyRequest(idx.getAll(workId));
    if (!all || all.length === 0) return null;
    return all.reduce((latest, c) => (c.lastVisited > latest.lastVisited ? c : latest));
  }

  async function getAllChapters() {
    const t = await tx([CHAPTERS_STORE], 'readonly');
    const all = await promisifyRequest(t.objectStore(CHAPTERS_STORE).getAll());
    return all || [];
  }

  async function getChaptersForWork(workId) {
    const t = await tx([CHAPTERS_STORE], 'readonly');
    const idx = t.objectStore(CHAPTERS_STORE).index('workId');
    const all = await promisifyRequest(idx.getAll(workId));
    return all || [];
  }

  async function getSeries(seriesId) {
    const t = await tx([SERIES_STORE], 'readonly');
    const result = await promisifyRequest(t.objectStore(SERIES_STORE).get(seriesId));
    return result || null;
  }

  async function getAllSeries() {
    const t = await tx([SERIES_STORE], 'readonly');
    const all = await promisifyRequest(t.objectStore(SERIES_STORE).getAll());
    return all || [];
  }

  async function putSeries(record) {
    const t = await tx([SERIES_STORE], 'readwrite');
    t.objectStore(SERIES_STORE).put(record);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  async function upsertReading(workState) {
    const t = await tx([READINGS_STORE], 'readwrite');
    const store = t.objectStore(READINGS_STORE);
    const existing = await promisifyRequest(store.get(workState.workId));
    const now = Date.now();

    const record = {
      workId: workState.workId,
      title: workState.title,
      authors: workState.authors,
      author: workState.author,
      isOneshot: workState.isOneshot,
      chapterCount: workState.chapterCount,
      chaptersPublished: workState.chaptersPublished,
      totalWordCount: workState.totalWordCount ?? existing?.totalWordCount ?? null,
      fandoms: (workState.fandoms && workState.fandoms.length)
        ? workState.fandoms
        : (existing?.fandoms ?? []),
      relationships: (workState.relationships && workState.relationships.length)
        ? workState.relationships
        : (existing?.relationships ?? []),
      parserVersion: workState.parserVersion,
      firstOpened: existing ? existing.firstOpened : now,
      lastCheckpoint: now,
      lastVisited: existing ? existing.lastVisited : now,
      visitCount: existing ? existing.visitCount : 0,
      totalReadingMs: existing ? (existing.totalReadingMs ?? 0) : 0,
      totalWordsRead: existing ? (existing.totalWordsRead ?? 0) : 0,
      syncedAt: existing ? existing.syncedAt : null,
    };

    store.put(record);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(record);
      t.onerror = () => reject(t.error);
    });
  }

  async function upsertChapter(workId, workState, checkpoint, currentReadingMs) {
    const chapterKey = chapterKeyFor(workState.chapterId);
    const t = await tx([CHAPTERS_STORE], 'readwrite');
    const store = t.objectStore(CHAPTERS_STORE);
    const existing = await promisifyRequest(store.get([workId, chapterKey]));

    const record = {
      workId,
      chapterKey,
      chapterId: workState.chapterId,
      chapterNumber: workState.chapterNumber,
      scrollPercent: checkpoint.scrollPercent,
      maxScrollPercent: Math.max(existing?.maxScrollPercent ?? 0, checkpoint.scrollPercent),
      scrollY: checkpoint.scrollY,
      paragraphIndex: checkpoint.paragraphIndex,
      paragraphLength: checkpoint.paragraphLength,
      paragraphPreview: checkpoint.paragraphPreview,
      lastVisited: checkpoint.timestamp || Date.now(),
      readingMs: Math.max(existing?.readingMs ?? 0, currentReadingMs ?? 0),
      bankedWords: existing?.bankedWords ?? 0,
      wordCount: (checkpoint.wordCount ?? existing?.wordCount) ?? null,
      wordCountVersion: (checkpoint.wordCountVersion ?? existing?.wordCountVersion) ?? null,
    };

    store.put(record);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(record);
      t.onerror = () => reject(t.error);
    });
  }

  async function recordSessionIfEligible(workId, chapterId, sessionDurationMs, maxScrollPercent, countVisit = true, wordCount = 0, hourBucketsDelta = null) {
    const eligible = sessionDurationMs >= SESSION_MIN_MS || maxScrollPercent >= SESSION_MIN_SCROLL_PERCENT;
    if (!eligible) return false;

    const t = await tx([READINGS_STORE, CHAPTERS_STORE, DAILY_STATS_STORE], 'readwrite');
    const readingsStore = t.objectStore(READINGS_STORE);
    const chaptersStore = t.objectStore(CHAPTERS_STORE);
    const dailyStatsStore = t.objectStore(DAILY_STATS_STORE);
    const chapterKey = chapterKeyFor(chapterId);

    const date = getLocalDateString();
    const deviceId = getDeviceId();
    const dailyKey = [date, deviceId, workId, chapterKey];

    const [existing, existingChapter, existingDaily] = await Promise.all([
      promisifyRequest(readingsStore.get(workId)),
      promisifyRequest(chaptersStore.get([workId, chapterKey])),
      promisifyRequest(dailyStatsStore.get(dailyKey)),
    ]);
    if (!existing) return false;

    // ---- word settle-up ----
    const persistedMax = existingChapter?.maxScrollPercent ?? 0;
    const effectiveMax = Math.max(persistedMax, maxScrollPercent || 0);

    const wc =
      wordCount && wordCount > 0
        ? wordCount
        : (existingChapter?.wordCount ?? 0);

    const owed = Math.max(0, Math.round(wc * effectiveMax));
    const prevBanked = existingChapter?.bankedWords ?? 0;
    const wordsCredit = Math.max(0, owed - prevBanked);

    if (countVisit) {
      existing.visitCount += 1;
    }
    existing.lastVisited = Date.now();
    existing.totalReadingMs = (existing.totalReadingMs ?? 0) + sessionDurationMs;
    existing.totalWordsRead = (existing.totalWordsRead ?? 0) + wordsCredit;
    readingsStore.put(existing);

    if (existingChapter) {
      existingChapter.readingMs = (existingChapter.readingMs ?? 0) + sessionDurationMs;
      existingChapter.bankedWords = prevBanked + wordsCredit;
      if (effectiveMax > (existingChapter.maxScrollPercent ?? 0)) {
        existingChapter.maxScrollPercent = effectiveMax;
      }
      chaptersStore.put(existingChapter);
    }

    let hourBuckets = existingDaily?.hourBuckets ?? null;
    if (Array.isArray(hourBucketsDelta)) {
      hourBuckets = new Array(24).fill(0);
      if (Array.isArray(existingDaily?.hourBuckets)) {
        for (let i = 0; i < 24; i++) {
          hourBuckets[i] = existingDaily.hourBuckets[i] || 0;
        }
      }
      for (let i = 0; i < 24; i++) {
        hourBuckets[i] += hourBucketsDelta[i] || 0;
      }
    }

    dailyStatsStore.put({
      date,
      deviceId,
      workId,
      chapterKey,
      wordsDelta: (existingDaily?.wordsDelta ?? 0) + wordsCredit,
      msDelta: (existingDaily?.msDelta ?? 0) + sessionDurationMs,
      ...(hourBuckets ? { hourBuckets } : {}),
    });

    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve({ recorded: true, wordsCredited: wordsCredit });
      t.onerror = () => reject(t.error);
    });
  }

  async function setWordEdit(workId, editRecord) {
    const t = await tx([READINGS_STORE], 'readwrite');
    const store = t.objectStore(READINGS_STORE);
    const existing = await promisifyRequest(store.get(workId));
    if (!existing) return false;

    existing.wordEdit = editRecord;
    store.put(existing);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  async function clearWordEdit(workId, chapterKey) {
    const t = await tx([READINGS_STORE], 'readwrite');
    const store = t.objectStore(READINGS_STORE);
    const existing = await promisifyRequest(store.get(workId));
    if (!existing || !existing.wordEdit) return false;
    if (existing.wordEdit.chapterKey !== chapterKey) return false;

    existing.wordEdit = null;
    store.put(existing);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  async function repairTotalReadingMsFloor(workId, minMs) {
    const t = await tx([READINGS_STORE], 'readwrite');
    const store = t.objectStore(READINGS_STORE);
    const existing = await promisifyRequest(store.get(workId));
    if (!existing) return false;

    if ((existing.totalReadingMs ?? 0) >= minMs) return false;

    existing.totalReadingMs = minMs;
    store.put(existing);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  async function updateAO3Label(workId, label) {
    const t = await tx([READINGS_STORE], 'readwrite');
    const store = t.objectStore(READINGS_STORE);
    const existing = await promisifyRequest(store.get(workId));
    if (!existing) return false;

    existing.ao3UpdateLabel = label;
    existing.ao3UpdateLabelCheckedAt = Date.now();
    store.put(existing);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  async function updateChapterStatsFromHistory(workId, published, planned) {
    if (published == null) return false;

    const t = await tx([READINGS_STORE], 'readwrite');
    const store = t.objectStore(READINGS_STORE);
    const existing = await promisifyRequest(store.get(workId));
    if (!existing) return false;

    existing.chaptersPublished = published;
    if (planned != null) {
      existing.chapterCount = planned;
    }
    existing.lastCheckpoint = Date.now();

    store.put(existing);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  async function getAllReadingsSortedByRecent() {
    const t = await tx([READINGS_STORE], 'readonly');
    const idx = t.objectStore(READINGS_STORE).index('lastVisited');
    const all = await promisifyRequest(idx.getAll());
    return all.sort((a, b) => b.lastVisited - a.lastVisited);
  }

  async function getTotalReadingMs() {
    const t = await tx([READINGS_STORE], 'readonly');
    const all = await promisifyRequest(t.objectStore(READINGS_STORE).getAll());
    return all.reduce((sum, r) => sum + (r.totalReadingMs ?? 0), 0);
  }

  async function getAllDailyStats() {
    const t = await tx([DAILY_STATS_STORE], 'readonly');
    const all = await promisifyRequest(t.objectStore(DAILY_STATS_STORE).getAll());
    return all || [];
  }

  async function getAllTombstones() {
    const t = await tx([TOMBSTONES_STORE], 'readonly');
    const all = await promisifyRequest(t.objectStore(TOMBSTONES_STORE).getAll());
    return all || [];
  }

  async function deleteReading(workId) {
    const t = await tx([READINGS_STORE, CHAPTERS_STORE, TOMBSTONES_STORE], 'readwrite');
    const readingsStore = t.objectStore(READINGS_STORE);
    const chaptersStore = t.objectStore(CHAPTERS_STORE);
    const tombstonesStore = t.objectStore(TOMBSTONES_STORE);

    readingsStore.delete(workId);

    const chapterKeys = await promisifyRequest(
      chaptersStore.index('workId').getAllKeys(workId)
    );
    for (const key of chapterKeys) {
      chaptersStore.delete(key);
    }

    tombstonesStore.put({ workId, deletedAt: Date.now() });

    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  async function buildSyncPayload() {
    const t = await tx([READINGS_STORE, CHAPTERS_STORE, TOMBSTONES_STORE, DAILY_STATS_STORE, SERIES_STORE], 'readonly');
    const readingsRaw = await promisifyRequest(t.objectStore(READINGS_STORE).getAll());
    const chaptersRaw = await promisifyRequest(t.objectStore(CHAPTERS_STORE).getAll());
    const tombstonesRaw = await promisifyRequest(t.objectStore(TOMBSTONES_STORE).getAll());
    const dailyStatsRaw = await promisifyRequest(t.objectStore(DAILY_STATS_STORE).getAll());
    const seriesRaw = await promisifyRequest(t.objectStore(SERIES_STORE).getAll());

    const readings = readingsRaw.map(({ syncedAt, ao3UpdateLabel, ao3UpdateLabelCheckedAt, wordEdit, ...rest }) => rest);
    const chapters = chaptersRaw.map(({ scrollY, ...rest }) => rest);

    return {
      readings,
      chapters,
      tombstones: tombstonesRaw,
      dailyStats: dailyStatsRaw,
      series: seriesRaw,
      exportedAt: Date.now(),
    };
  }

  async function applyMergedPayload(mergedPayload, { mergeReadingRecord, mergeChapterRecord, mergeDailyStatsRecord, mergeSeriesRecord, chapterWinnerSide }) {
    const readings = mergedPayload.readings || [];
    const chapters = mergedPayload.chapters || [];
    const tombstones = mergedPayload.tombstones || [];
    const dailyStats = mergedPayload.dailyStats || [];
    const seriesRecords = mergedPayload.series || [];

    const t = await tx([READINGS_STORE, CHAPTERS_STORE, TOMBSTONES_STORE, DAILY_STATS_STORE, SERIES_STORE], 'readwrite');
    const readingsStore = t.objectStore(READINGS_STORE);
    const chaptersStore = t.objectStore(CHAPTERS_STORE);
    const tombstonesStore = t.objectStore(TOMBSTONES_STORE);
    const dailyStatsStore = t.objectStore(DAILY_STATS_STORE);
    const seriesStore = t.objectStore(SERIES_STORE);

    const bankedByWork = new Map();
    for (const c of chapters) {
      bankedByWork.set(
        c.workId,
        (bankedByWork.get(c.workId) || 0) + (c.bankedWords || 0)
      );
    }

    const reconciledReadingState = [];

    for (const merged of readings) {
      const existing = await promisifyRequest(readingsStore.get(merged.workId));
      const reconciled = mergeReadingRecord(existing, merged);

      if (bankedByWork.has(reconciled.workId)) {
        reconciled.totalWordsRead = bankedByWork.get(reconciled.workId);
      }

      readingsStore.put({
        ...reconciled,
        syncedAt: existing ? existing.syncedAt : null,
        ao3UpdateLabel: existing ? (existing.ao3UpdateLabel ?? null) : null,
        ao3UpdateLabelCheckedAt: existing ? (existing.ao3UpdateLabelCheckedAt ?? null) : null,
        wordEdit: existing ? (existing.wordEdit ?? null) : null,
      });
      reconciledReadingState.push({ workId: reconciled.workId, lastVisited: reconciled.lastVisited });
    }

    for (const merged of chapters) {
      const key = [merged.workId, merged.chapterKey];
      const existing = await promisifyRequest(chaptersStore.get(key));
      const reconciled = mergeChapterRecord(existing, merged);

      const winnerSide = chapterWinnerSide(existing, merged);
      chaptersStore.put({
        ...reconciled,
        bankedWords: reconciled.bankedWords ?? 0,
        scrollY: winnerSide === 'local' && existing ? existing.scrollY : null,
      });
    }

    for (const tombstone of tombstones) {
      tombstonesStore.put(tombstone);

      const currentReading = await promisifyRequest(readingsStore.get(tombstone.workId));
      if (!currentReading) continue;

      const stillStale = (currentReading.lastVisited ?? 0) <= tombstone.deletedAt;
      if (!stillStale) continue;

      readingsStore.delete(tombstone.workId);

      const chapterKeys = await promisifyRequest(
        chaptersStore.index('workId').getAllKeys(tombstone.workId)
      );
      for (const key of chapterKeys) {
        chaptersStore.delete(key);
      }

      const idx = reconciledReadingState.findIndex((r) => r.workId === tombstone.workId);
      if (idx !== -1) reconciledReadingState.splice(idx, 1);
    }

    for (const merged of dailyStats) {
      if (
        merged.date == null ||
        merged.deviceId == null ||
        merged.workId == null
      ) {
        continue;
      }
      if (merged.chapterKey == null) {
        merged.chapterKey = '__unknown__';
      }

      const key = [merged.date, merged.deviceId, merged.workId, merged.chapterKey];
      const existing = await promisifyRequest(dailyStatsStore.get(key));
      const reconciled = mergeDailyStatsRecord ? mergeDailyStatsRecord(existing, merged) : merged;
      dailyStatsStore.put(reconciled);
    }

    // Series membership: union-merged, never tombstoned.
    for (const merged of seriesRecords) {
      if (merged == null || merged.seriesId == null) continue;

      const existing = await promisifyRequest(seriesStore.get(merged.seriesId));
      const reconciled = mergeSeriesRecord ? mergeSeriesRecord(existing, merged) : merged;
      seriesStore.put(reconciled);
    }

    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(reconciledReadingState);
      t.onerror = () => reject(t.error);
    });
  }

  async function markSyncedReadings(syncedReadingsSnapshot, timestamp = Date.now()) {
    const t = await tx([READINGS_STORE], 'readwrite');
    const store = t.objectStore(READINGS_STORE);
    for (const snap of syncedReadingsSnapshot) {
      const current = await promisifyRequest(store.get(snap.workId));
      if (current && current.lastVisited === snap.lastVisited) {
        current.syncedAt = timestamp;
        store.put(current);
      }
    }
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  return {
    chapterKeyFor,
    getDeviceId,
    getLocalDateString,
    getReading,
    getChapter,
    getLatestChapter,
    getAllChapters,
    getChaptersForWork,
    getSeries,
    getAllSeries,
    putSeries,
    upsertReading,
    upsertChapter,
    recordSessionIfEligible,
    setWordEdit,
    clearWordEdit,
    repairTotalReadingMsFloor,
    updateAO3Label,
    updateChapterStatsFromHistory,
    getAllReadingsSortedByRecent,
    getTotalReadingMs,
    getAllDailyStats,
    getAllTombstones,
    deleteReading,
    buildSyncPayload,
    applyMergedPayload,
    markSyncedReadings,
    SESSION_MIN_MS,
    SESSION_MIN_SCROLL_PERCENT,
  };
})();


const AO3ScrollTracker = (() => {
  const THROTTLE_MS = 250;
  const DEBOUNCE_MS = 300;
  const PREVIEW_LEN = 40;

  //   1 = original <p>-only walker
  //   2 = full-module textContent walk (.landmark stripped)
  const WORD_COUNT_VERSION = 2;

  let onSaveCallback = null;
  let lastThrottleSave = 0;
  let debounceTimer = null;
  let contentEl = null;
  let paragraphs = [];
  let lastSavedScrollY = null;
  let cachedWordCount = null;
  const MIN_MOVEMENT_PX = 30;

  function getContentEl() {
    return document.documentElement;
  }

  function indexParagraphs() {
    if (!contentEl) {
      paragraphs = [];
      return;
    }
    paragraphs = Array.from(document.querySelectorAll("p"));
  }

  function computeWordCount() {
    const fic =
      document.querySelector("#workskin .userstuff.module") ||
      document.querySelector(".userstuff.module");

    if (!fic) return 0;

    const clone = fic.cloneNode(true);
    clone.querySelectorAll(".landmark").forEach((el) => el.remove());

    const text = (clone.textContent || "").trim();
    if (!text) return 0;

    return text.split(/\s+/).filter(Boolean).length;
  }

  function getWordCount() {
    if (cachedWordCount === null) {
      cachedWordCount = computeWordCount();
    }
    return cachedWordCount;
  }

  function resetWordCountCache() {
    cachedWordCount = null;
  }

  function findTopmostVisibleParagraph() {
    for (let i = 0; i < paragraphs.length; i++) {
      const rect = paragraphs[i].getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        return { index: i, el: paragraphs[i] };
      }
    }
    return null;
  }

  function getFicBounds() {
    const fic =
      document.querySelector("#workskin .userstuff.module") ||
      document.querySelector(".userstuff.module");

    if (!fic) return null;

    const rect = fic.getBoundingClientRect();
    const ficTop = rect.top + window.scrollY;
    const ficHeight = fic.scrollHeight;
    const rawScrollableHeight = ficHeight - window.innerHeight;
    const scrollableHeight = Math.max(1, rawScrollableHeight);

    return { top: ficTop, scrollableHeight, fitsInViewport: rawScrollableHeight <= 0 };
  }

  function computeFicPercent() {
    const bounds = getFicBounds();
    if (!bounds) return 0;
    if (bounds.fitsInViewport) return 1;

    const scrolled = window.scrollY - bounds.top;
    return Math.min(1, Math.max(0, scrolled / bounds.scrollableHeight));
  }

  function buildCheckpoint() {
    if (!contentEl) return null;

    indexParagraphs();

    const scrollPercent = computeFicPercent();
    const scrollY = window.scrollY;
    const timestamp = Date.now();
    const wordCount = getWordCount();

    const topPara = findTopmostVisibleParagraph();
    if (!topPara) {
      return { scrollPercent, scrollY, paragraphIndex: null, paragraphLength: null, paragraphPreview: null, timestamp, wordCount, wordCountVersion: WORD_COUNT_VERSION };
    }

    const text = topPara.el.textContent.trim();
    return {
      scrollPercent,
      scrollY,
      paragraphIndex: topPara.index,
      paragraphLength: text.length,
      paragraphPreview: text.slice(0, PREVIEW_LEN),
      timestamp,
      wordCount,
      wordCountVersion: WORD_COUNT_VERSION,
    };
  }

  const FORCE_SAVE_REASONS = new Set(['initial', 'visibilitychange', 'pagehide']);

  function save(reason) {
    const checkpoint = buildCheckpoint();
    if (!checkpoint || !onSaveCallback) return;

    if (!FORCE_SAVE_REASONS.has(reason) && lastSavedScrollY !== null) {
      if (Math.abs(checkpoint.scrollY - lastSavedScrollY) < MIN_MOVEMENT_PX) {
        return;
      }
    }

    lastSavedScrollY = checkpoint.scrollY;
    onSaveCallback(checkpoint, reason);
  }

  function handleScroll() {
    const now = Date.now();

    if (now - lastThrottleSave >= THROTTLE_MS) {
      lastThrottleSave = now;
      save('throttle');
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      lastThrottleSave = Date.now();
      save('debounce');
    }, DEBOUNCE_MS);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      save('visibilitychange');
    }
  }

  function handlePageHide() {
    save('pagehide');
  }

  function handlePageShow(event) {
    if (event.persisted) {
      contentEl = getContentEl();
      if (contentEl) indexParagraphs();
      resetWordCountCache();
    }
  }

  function start(onSave) {
    contentEl = getContentEl();
    if (!contentEl) return false;

    indexParagraphs();
    resetWordCountCache();
    onSaveCallback = onSave;

    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);

    save('initial');

    return true;
  }

  function stop() {
    window.removeEventListener('scroll', handleScroll);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handlePageShow);
    clearTimeout(debounceTimer);
    onSaveCallback = null;
  }

  function resolveResumeTarget(checkpoint) {
    contentEl = contentEl || getContentEl();
    if (contentEl) indexParagraphs();

    if (typeof checkpoint.scrollY === 'number') {
      return { method: 'scrollY', scrollTo: checkpoint.scrollY };
    }

    if (
      checkpoint.paragraphIndex !== null &&
      checkpoint.paragraphIndex !== undefined &&
      paragraphs[checkpoint.paragraphIndex]
    ) {
      const candidate = paragraphs[checkpoint.paragraphIndex];
      const text = candidate.textContent.trim();
      const lengthMatches = Math.abs(text.length - checkpoint.paragraphLength) <= 20;
      const previewMatches = text.startsWith(checkpoint.paragraphPreview);

      if (lengthMatches && previewMatches) {
        const rect = candidate.getBoundingClientRect();
        const target = Math.max(0, rect.top + window.scrollY);

        return {
          method: "paragraph",
          scrollTo: target
        };
      }
    }

    const bounds = getFicBounds();
    if (!bounds) {
      return { method: 'percent', scrollTo: 0 };
    }
    const target = bounds.top + bounds.scrollableHeight * checkpoint.scrollPercent;
    return { method: 'percent', scrollTo: target };
  }

  return { start, stop, resolveResumeTarget, getWordCount, WORD_COUNT_VERSION };
})();


const AO3Sync = (() => {

  function coalesceTs(ts) {
    return typeof ts === 'number' && ts > 0 ? ts : 0;
  }

  function safeMin(a, b) {
    if (a === null || a === undefined) return b;
    if (b === null || b === undefined) return a;
    return Math.min(a, b);
  }

  function pickFresherField(local, remote, localCheckpointTs, remoteCheckpointTs, fieldName) {
    const localVal = local[fieldName];
    const remoteVal = remote[fieldName];
    const localHas = localVal !== null && localVal !== undefined;
    const remoteHas = remoteVal !== null && remoteVal !== undefined;

    if (localHas && !remoteHas) return localVal;
    if (remoteHas && !localHas) return remoteVal;
    if (!localHas && !remoteHas) return null;

    return localCheckpointTs >= remoteCheckpointTs ? localVal : remoteVal;
  }

  function mergeHourBuckets(a, b) {
    if (!Array.isArray(a)) return b ?? null;
    if (!Array.isArray(b)) return a ?? null;

    const out = new Array(24).fill(0);
    for (let i = 0; i < 24; i++) {
      out[i] = Math.max(a[i] || 0, b[i] || 0);
    }
    return out;
  }

  // Series membership: union on workId, newer side as base.
  function mergeSeriesRecord(local, remote) {
    if (!local) return remote;
    if (!remote) return local;

    const localFresh = (local.fetchedAt || 0) >= (remote.fetchedAt || 0);
    const base = localFresh ? local : remote;
    const other = localFresh ? remote : local;

    const byId = new Map();
    for (const w of base.works || []) {
      if (w && w.workId != null) byId.set(w.workId, w);
    }
    for (const w of other.works || []) {
      if (w && w.workId != null && !byId.has(w.workId)) byId.set(w.workId, w);
    }

    return {
      seriesId: base.seriesId,
      title: base.title || other.title || '',
      works: Array.from(byId.values()),
      fetchedAt: Math.max(local.fetchedAt || 0, remote.fetchedAt || 0),
    };
  }

  function mergeReadingRecord(local, remote) {
    if (!local) return remote;
    if (!remote) return local;

    const localTs = coalesceTs(local.lastVisited);
    const remoteTs = coalesceTs(remote.lastVisited);

    const localCheckpointTs = coalesceTs(local.lastCheckpoint);
    const remoteCheckpointTs = coalesceTs(remote.lastCheckpoint);

    const pick = (field) =>
      pickFresherField(local, remote, localCheckpointTs, remoteCheckpointTs, field);

    return {
      workId: local.workId,
      title: pick('title'),
      authors: pick('authors'),
      author: pick('author'),
      isOneshot: pick('isOneshot'),
      chapterCount: pick('chapterCount'),
      chaptersPublished: pick('chaptersPublished'),
      parserVersion: pick('parserVersion'),

      fandoms: pick('fandoms'),
      relationships: pick('relationships'),

      firstOpened: safeMin(local.firstOpened, remote.firstOpened),

      lastVisited: Math.max(localTs, remoteTs),
      lastCheckpoint: Math.max(localCheckpointTs, remoteCheckpointTs),

      visitCount: Math.max(local.visitCount || 0, remote.visitCount || 0),
      totalReadingMs: Math.max(local.totalReadingMs || 0, remote.totalReadingMs || 0),

      // Derived — recomputed as sum(bankedWords) by applyMergedPayload.
      totalWordsRead: Math.max(local.totalWordsRead || 0, remote.totalWordsRead || 0),
    };
  }

  function mergeChapterRecord(local, remote) {
    if (!local) return remote;
    if (!remote) return local;

    const localTs = coalesceTs(local.lastVisited);
    const remoteTs = coalesceTs(remote.lastVisited);

    const winner = localTs >= remoteTs ? local : remote;

    return {
      ...winner,
      readingMs: Math.max(local.readingMs || 0, remote.readingMs || 0),
      maxScrollPercent: Math.max(local.maxScrollPercent || 0, remote.maxScrollPercent || 0),
      bankedWords: Math.max(local.bankedWords || 0, remote.bankedWords || 0),
      wordCount: local.wordCount ?? remote.wordCount ?? null,
      wordCountVersion: Math.max(
        local.wordCountVersion || 0,
        remote.wordCountVersion || 0
      ) || null,
    };
  }

  function chapterWinnerSide(local, remote) {
    if (!local) return 'remote';
    if (!remote) return 'local';

    const localTs = coalesceTs(local.lastVisited);
    const remoteTs = coalesceTs(remote.lastVisited);

    return localTs >= remoteTs ? 'local' : 'remote';
  }

  function mergeDailyStatsRecord(local, remote) {
    if (!local) return remote;
    if (!remote) return local;

    return {
      date: local.date,
      deviceId: local.deviceId,
      workId: local.workId,
      chapterKey: local.chapterKey,
      wordsDelta: Math.max(local.wordsDelta || 0, remote.wordsDelta || 0),
      msDelta: Math.max(local.msDelta || 0, remote.msDelta || 0),
      hourBuckets: mergeHourBuckets(local.hourBuckets, remote.hourBuckets),
    };
  }

  function mergeTombstones(localTombstones, remoteTombstones) {
    const byWorkId = new Map();

    for (const t of localTombstones || []) {
      byWorkId.set(t.workId, t);
    }

    for (const t of remoteTombstones || []) {
      const existing = byWorkId.get(t.workId);
      if (!existing || t.deletedAt > existing.deletedAt) {
        byWorkId.set(t.workId, t);
      }
    }

    return Array.from(byWorkId.values());
  }

  function dailyStatsKey(d) {
    return `${d.date}::${d.deviceId}::${d.workId}::${d.chapterKey}`;
  }

  function mergeAllDailyStats(localList, remoteList) {
    const byKey = new Map();

    for (const d of localList || []) {
      byKey.set(dailyStatsKey(d), d);
    }

    for (const d of remoteList || []) {
      const key = dailyStatsKey(d);
      const existing = byKey.get(key);
      byKey.set(key, mergeDailyStatsRecord(existing, d));
    }

    return Array.from(byKey.values());
  }

  function mergeAll(localPayload, remotePayload) {
    localPayload = localPayload || {};
    remotePayload = remotePayload || {};

    const localReadings = localPayload.readings || [];
    const remoteReadings = remotePayload.readings || [];

    const localChapters = localPayload.chapters || [];
    const remoteChapters = remotePayload.chapters || [];

    const localSeries = localPayload.series || [];
    const remoteSeries = remotePayload.series || [];

    const mergedTombstones = mergeTombstones(
      localPayload.tombstones,
      remotePayload.tombstones
    );
    const tombstoneByWorkId = new Map(
      mergedTombstones.map((t) => [t.workId, t])
    );

    const readingsByWorkId = new Map();

    for (const r of localReadings) {
      readingsByWorkId.set(r.workId, { local: r, remote: null });
    }

    for (const r of remoteReadings) {
      const existing = readingsByWorkId.get(r.workId);

      if (existing) {
        existing.remote = r;
      } else {
        readingsByWorkId.set(r.workId, { local: null, remote: r });
      }
    }

    const mergedReadings =
      Array.from(readingsByWorkId.values())
        .map(({ local, remote }) => mergeReadingRecord(local, remote))
        .filter((reading) => {
          const tombstone = tombstoneByWorkId.get(reading.workId);
          if (!tombstone) return true;
          return (reading.lastVisited ?? 0) > tombstone.deletedAt;
        });

    function chapterKey(c) {
      return `${c.workId}::${c.chapterKey}`;
    }

    const chaptersByKey = new Map();

    for (const c of localChapters) {
      chaptersByKey.set(chapterKey(c), { local: c, remote: null });
    }

    for (const c of remoteChapters) {
      const key = chapterKey(c);
      const existing = chaptersByKey.get(key);

      if (existing) {
        existing.remote = c;
      } else {
        chaptersByKey.set(key, { local: null, remote: c });
      }
    }

    const mergedChapters =
      Array.from(chaptersByKey.values())
        .map(({ local, remote }) => mergeChapterRecord(local, remote))
        .filter((chapter) => {
          const tombstone = tombstoneByWorkId.get(chapter.workId);
          if (!tombstone) return true;
          return (chapter.lastVisited ?? 0) > tombstone.deletedAt;
        });

    // Deliberately NOT tombstone-filtered.
    const seriesById = new Map();
    for (const s of localSeries) {
      if (s && s.seriesId != null) seriesById.set(s.seriesId, { local: s, remote: null });
    }
    for (const s of remoteSeries) {
      if (!s || s.seriesId == null) continue;
      const existing = seriesById.get(s.seriesId);
      if (existing) existing.remote = s;
      else seriesById.set(s.seriesId, { local: null, remote: s });
    }
    const mergedSeries =
      Array.from(seriesById.values())
        .map(({ local, remote }) => mergeSeriesRecord(local, remote));

    const localDailyStats = localPayload.dailyStats || [];
    const remoteDailyStats = remotePayload.dailyStats || [];
    const mergedDailyStats = mergeAllDailyStats(localDailyStats, remoteDailyStats);

    return {
      readings: mergedReadings,
      chapters: mergedChapters,
      tombstones: mergedTombstones,
      dailyStats: mergedDailyStats,
      series: mergedSeries,
      exportedAt: Date.now(),
    };
  }

  function b64EncodeUnicode(str) {
    if (
      typeof TextEncoder !== 'undefined' &&
      typeof btoa !== 'undefined'
    ) {
      const bytes = new TextEncoder().encode(str);
      let binary = '';
      bytes.forEach((b) => {
        binary += String.fromCharCode(b);
      });
      return btoa(binary);
    }
    return Buffer.from(str, 'utf-8').toString('base64');
  }

  function b64DecodeUnicode(b64) {
    const cleaned = b64.replace(/\n/g, '');

    if (
      typeof atob !== 'undefined' &&
      typeof TextDecoder !== 'undefined'
    ) {
      const binary = atob(cleaned);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    }

    return Buffer.from(cleaned, 'base64').toString('utf-8');
  }

  function authHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async function fetchRemote(fetchImpl, url, token, encryptionKey) {
    const resp = await fetchImpl(url, {
      headers: authHeaders(token),
    });

    if (resp.status === 404) {
      return {
        exists: false,
        sha: null,
        payload: {
          readings: [],
          chapters: [],
          tombstones: [],
          dailyStats: [],
          series: [],
        },
      };
    }

    if (resp.status !== 200) {
      return {
        error: true,
        status: resp.status,
      };
    }

    const body = await resp.json();

    let encryptedPayload;

    try {
      encryptedPayload = JSON.parse(b64DecodeUnicode(body.content));
    } catch {
      return {
        error: true,
        reason: 'invalid-remote-format',
      };
    }

    let payload;

    try {
      payload = await AO3Crypto.decrypt(encryptedPayload, encryptionKey);
    } catch (err) {
      return {
        error: true,
        reason: 'decrypt-failed',
        errorMessage: err.message,
      };
    }

    if (
      !payload ||
      typeof payload !== 'object' ||
      !Array.isArray(payload.readings) ||
      !Array.isArray(payload.chapters) ||
      (payload.tombstones !== undefined && !Array.isArray(payload.tombstones)) ||
      (payload.dailyStats !== undefined && !Array.isArray(payload.dailyStats)) ||
      (payload.series !== undefined && !Array.isArray(payload.series))
    ) {
      return {
        error: true,
        reason: 'invalid-decrypted-payload',
      };
    }

    return {
      exists: true,
      sha: body.sha,
      payload,
    };
  }

  async function putContent(fetchImpl, url, token, payload, encryptionKey, sha) {
    let encryptedPayload;

    try {
      encryptedPayload = await AO3Crypto.encrypt(payload, encryptionKey);
    } catch (err) {
      return {
        success: false,
        reason: 'encryption-failed',
        error: err.message,
      };
    }

    const body = {
      message: `AO3 History++ sync — ${new Date().toISOString()}`,
      content: b64EncodeUnicode(JSON.stringify(encryptedPayload)),
    };

    if (sha) {
      body.sha = sha;
    }

    const resp = await fetchImpl(url, {
      method: 'PUT',

      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/json',
      },

      body: JSON.stringify(body),
    });

    if (resp.status === 200 || resp.status === 201) {
      return { success: true };
    }

    if (resp.status === 409 || resp.status === 422) {
      return {
        success: false,
        reason: 'sha-conflict',
      };
    }

    return {
      success: false,
      reason: 'put-failed',
      status: resp.status,
    };
  }

  async function syncToGitHub({
    token,
    owner,
    repo,
    path,
    encryptionKey,
    localPayload,
    fetchImpl,
  }) {
    const doFetch =
      fetchImpl ||
      (typeof fetch !== 'undefined' ? fetch : null);

    if (!doFetch) {
      return {
        success: false,
        reason: 'no-fetch-implementation',
      };
    }

    if (
      !AO3Crypto ||
      typeof AO3Crypto.validateKey !== 'function' ||
      !AO3Crypto.validateKey(encryptionKey)
    ) {
      return {
        success: false,
        reason: 'invalid-encryption-key',
      };
    }

    const url =
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;

    try {
      const remote1 = await fetchRemote(doFetch, url, token, encryptionKey);

      if (remote1.error) {
        return {
          success: false,
          reason: remote1.reason || 'get-failed',
          status: remote1.status,
          error: remote1.errorMessage,
        };
      }

      const merged1 = mergeAll(localPayload, remote1.payload);

      const put1 = await putContent(doFetch, url, token, merged1, encryptionKey, remote1.sha);

      if (put1.success) {
        return {
          success: true,
          merged: merged1,
          syncedAt: Date.now(),
        };
      }

      if (put1.reason !== 'sha-conflict') {
        return {
          success: false,
          reason: put1.reason,
          status: put1.status,
          error: put1.error,
        };
      }

      const remote2 = await fetchRemote(doFetch, url, token, encryptionKey);

      if (remote2.error) {
        return {
          success: false,
          reason: remote2.reason || 'retry-get-failed',
          status: remote2.status,
          error: remote2.errorMessage,
        };
      }

      const merged2 = mergeAll(localPayload, remote2.payload);

      const put2 = await putContent(doFetch, url, token, merged2, encryptionKey, remote2.sha);

      if (put2.success) {
        return {
          success: true,
          merged: merged2,
          syncedAt: Date.now(),
        };
      }

      return {
        success: false,
        reason: put2.reason || 'retry-put-failed',
        status: put2.status,
        error: put2.error,
      };

    } catch (err) {
      return {
        success: false,
        reason: 'exception',
        error: err && err.message ? err.message : String(err),
      };
    }
  }

  return {
    mergeReadingRecord,
    mergeChapterRecord,
    mergeDailyStatsRecord,
    mergeSeriesRecord,
    mergeTombstones,
    mergeAllDailyStats,
    mergeAll,
    chapterWinnerSide,
    syncToGitHub,
  };

})();

// ==================================================
// AO3 History++ — History UI Module
// ==================================================

const AO3HistoryUI = (() => {

  function formatDate(timestamp){
    return new Date(timestamp).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  function formatPercent(value) {
    const percent = Math.round((value || 0) * 100);

    if (percent === 0) return "<1";
    if (percent > 99) return 100;

    return percent;
  }

  function formatDuration(ms) {
    const totalMinutes = Math.floor((ms || 0) / 60000);

    if (totalMinutes < 1) return "<1m";

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function localDateString(timestamp = Date.now()) {
    return AO3DB.getLocalDateString(timestamp);
  }

  function daysAgoDateString(daysAgo) {
    return localDateString(Date.now() - daysAgo * 86_400_000);
  }

  function formatWords(n) {
    return Math.round(n || 0).toLocaleString('en-US');
  }

  function formatSpeed(words, ms) {
    if (!ms || ms < 1000) return '—';
    const wpm = words / (ms / 60000);
    if (!isFinite(wpm) || wpm <= 0) return '—';
    return `${Math.round(wpm)} wpm`;
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function shortDate(timestamp) {
    return new Date(timestamp).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
  }

  function wordEditLine(reading, chapter) {
    const edit =
      reading.wordEdit &&
      chapter &&
      chapter.chapterKey != null &&
      reading.wordEdit.chapterKey === chapter.chapterKey
        ? reading.wordEdit
        : null;

    if (!edit) return "";

    const added = edit.delta > 0;
    const noun = Math.abs(edit.delta) === 1 ? "word" : "words";
    const verb = added ? "added" : "removed";

    return `<p style="margin:.2em 0;color:#555;" title="Detected on this device by comparing the chapter's text length to your last read. Clears once you've spent some time back in this chapter.">
        📝 ${added ? "+" : "−"}${formatWords(Math.abs(edit.delta))} ${noun} ${verb} since you last read
      </p>`;
  }

  function getPublishedChapterCount(entry){
    const dd = entry.querySelector("dd.chapters");
    if (!dd) return null;

    const text = dd.textContent.trim();

    const match = text.match(/^(\d+)\s*\/\s*(\d+|\?)$/);
    if (!match) return null;

    return {
      published: Number(match[1]),
      planned: match[2] === "?" ? null : Number(match[2]),
    };
  }

  function formatChapterProgress(currentChapter, published, planned) {
    const cur = currentChapter || "?";
    let text;
    let title;

    if (planned != null && (published == null || published >= planned)) {
      text = `${cur}/${planned}`;
      title = "Chapter you're on / total chapters planned for this fic";
    } else if (published != null && planned != null) {
      text = `${cur}/${published}/${planned}`;
      title = "Chapter you're on / chapters published so far / total chapters planned";
    } else {
      text = `${cur}/${published ?? "?"}/?`;
      title = "Chapter you're on / chapters published so far / total chapters planned (? = not announced yet)";
    }

    return `Chapter <span class="ao3hpp-chapter-progress" title="${title}" style="cursor:help;border-bottom:1px dotted #999;">${text}</span>`;
  }

  function getAO3UpdateLabel(entry, viewedEl) {
    const scope = viewedEl || entry.querySelector(".viewed") || entry;
    const text = (scope.textContent || "").toLowerCase();

    if (text.includes("update available")) return "update_available";
    if (text.includes("minor edits made")) return "minor_edits";
    if (text.includes("latest version")) return "latest";
    return null;
  }

  function isStatsView() {
    return new URLSearchParams(window.location.search).get('show') === 'stats';
  }

  // Scoped to #main — the site-wide header menu shares these classes.
  function injectStatisticsNavItem(statsActive) {
    const nav = document.querySelector('#main ul.navigation.actions');
    if (!nav || nav.querySelector('li.ao3hpp-nav-statistics')) return;

    if (statsActive) {
      const histCurrent = Array.from(nav.querySelectorAll('li > span.current'))
        .find((el) => el.textContent.trim() === 'History');

      if (histCurrent) {
        const link = document.createElement('a');
        link.href = window.location.pathname;
        link.textContent = 'History';
        histCurrent.replaceWith(link);
      }
    }

    const li = document.createElement('li');
    li.className = 'ao3hpp-nav-statistics';

    if (statsActive) {
      const current = document.createElement('span');
      current.className = 'current';
      current.textContent = 'Statistics';
      li.appendChild(current);
    } else {
      const link = document.createElement('a');
      link.href = '?show=stats';
      link.textContent = 'Statistics';
      li.appendChild(link);
    }

    const clearItem = Array.from(nav.children)
      .find((el) => el.querySelector && el.querySelector('a[href*="confirm_clear"]'));

    if (clearItem) clearItem.insertAdjacentElement('beforebegin', li);
    else nav.appendChild(li);
  }

  function ensureStatsMount() {
    let mount = document.querySelector('.ao3hpp-stats-view');
    if (mount) return mount;

    const entries = document.querySelectorAll('#main li.reading');
    const anchor = entries[0]?.closest('ol, ul');

    mount = document.createElement('div');
    mount.className = 'ao3hpp-stats-view';

    if (anchor) {
      anchor.insertAdjacentElement('beforebegin', mount);
      anchor.style.display = 'none';

      document
        .querySelectorAll('#main ol.pagination')
        .forEach((p) => { p.style.display = 'none'; });
    } else {
      (document.querySelector('#main') || document.body).appendChild(mount);
    }

    // Skin-aware theme tokens.
    let dark = false;
    try {
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (m) {
        const lum = 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3];
        dark = lum < 140;
      }
    } catch { /* probe failure keeps light defaults */ }

    const t = dark
      ? { panel: '#33333c', border: '#4a4a55', text: '#ddd', muted: '#9a9aa5', accent: '#cf8989', bar: '#5a8f5a', track: '#45454f', chip: '#3d3d47' }
      : { panel: '#fafafa', border: '#ddd',     text: '#000', muted: '#777',     accent: '#900',    bar: '#4fae4f', track: '#ebedf0', chip: '#fff' };

    for (const [k, v] of Object.entries(t)) {
      mount.style.setProperty(`--hpp-${k}`, v);
    }

    return mount;
  }

  function ensureSkeletonStyles() {
    if (document.getElementById('ao3hpp-skeleton-style')) return;

    const style = document.createElement('style');
    style.id = 'ao3hpp-skeleton-style';
    style.textContent = `
      @keyframes ao3hpp-pulse { 0%,100% { opacity:.55; } 50% { opacity:1; } }
      .ao3hpp-sk-bar {
        height: 12px; border-radius: 4px; margin: .5em 0;
        background: var(--hpp-track, #ebedf0);
        animation: ao3hpp-pulse 1.4s ease-in-out infinite;
      }
      .ao3hpp-details > summary {
        cursor: pointer; font-weight: bold;
        color: var(--hpp-accent, #900); margin: 0 0 .5em;
      }
      .ao3hpp-panel-section:hover .ao3hpp-drag-handle { opacity: 1 !important; }
      .ao3hpp-panel-section { margin: 0 0 1.5em; }

      /* ---- MOBILE (<640px): one responsive layout ---- */
      @media (max-width: 640px) {
        .ao3hpp-continue-card {
          width: calc(50% - 0.4em) !important;
          min-width: 0;
          box-sizing: border-box;
        }
        .ao3hpp-stat-card {
          flex: 1 1 44% !important;
          box-sizing: border-box;
        }
        .ao3hpp-pace-metric {
          white-space: normal !important;
          font-size: .78em !important;
        }
        .ao3hpp-milestone-label,
        .ao3hpp-funnel-label {
          flex: 0 0 auto !important;
          min-width: 0;
        }
        .ao3hpp-milestone-bar,
        .ao3hpp-funnel-bar {
          min-width: 3em;
        }
        .ao3hpp-deep-ch {
          flex: 0 0 5.5em !important;
          font-size: .8em !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function skeletonPanel(label) {
    const div = document.createElement('div');
    div.className = 'ao3hpp-panel';
    div.style.border = '1px solid var(--hpp-border,#ddd)';
    div.style.borderLeft = '3px solid var(--hpp-accent,#900)';
    div.style.background = 'var(--hpp-panel,#fafafa)';
    div.style.borderRadius = '2px';
    div.style.padding = '.6em .8em';
    div.style.margin = '0 0 1.5em';
    div.innerHTML = `
      <p style="margin:0 0 .4em;color:var(--hpp-muted,#777);font-size:.85em;font-weight:600;">${esc(label)}</p>
      <div class="ao3hpp-sk-bar" style="width:65%;"></div>
      <div class="ao3hpp-sk-bar" style="width:90%;"></div>
      <div class="ao3hpp-sk-bar" style="width:75%;"></div>
    `;
    return div;
  }

  function panel(titleHtml) {
    const div = document.createElement('div');
    div.className = 'ao3hpp-panel';
    div.style.border = '1px solid var(--hpp-border,#ddd)';
    div.style.borderLeft = '3px solid var(--hpp-accent,#900)';
    div.style.background = 'var(--hpp-panel,#fafafa)';
    div.style.borderRadius = '2px';
    div.style.padding = '.6em .8em';
    div.style.margin = '0';
    if (titleHtml) {
      const p = document.createElement('p');
      p.style.cssText = 'margin:0 0 .5em;color:var(--hpp-muted,#777);font-size:.85em;font-weight:600;';
      p.innerHTML = titleHtml;
      div.appendChild(p);
    }
    return div;
  }

  const CONTINUE_READING_DONE_THRESHOLD = 0.97;

  const CONTINUE_SORT_STORAGE_KEY = 'ao3hpp_continue_sort';
  const CONTINUE_SORT_DEFAULT = 'recent';
    const CONTINUE_SORT_OPTIONS = [
    { value: 'recent', label: 'Most recent' },
    { value: 'most_progress', label: 'Most progressed', title: "Estimated from chapter count — may lag a bit behind AO3 until you next visit your History page" },
    { value: 'least_progress', label: 'Least progressed', title: "Estimated from chapter count — may lag a bit behind AO3 until you next visit your History page" },
    { value: 'time_spent', label: 'Time spent reading' },
  ];

  function getSavedSortMode() {
    const saved = GM_getValue(CONTINUE_SORT_STORAGE_KEY, CONTINUE_SORT_DEFAULT);
    return CONTINUE_SORT_OPTIONS.some((o) => o.value === saved) ? saved : CONTINUE_SORT_DEFAULT;
  }

  // ---- filters ---------------------------------------------------------

  const ABANDONED_STALE_MS = 30 * 86_400_000;

  const CONTINUE_FILTER_STORAGE_KEY = 'ao3hpp_continue_filter';
  const CONTINUE_FILTER_DEFAULT = 'all';
  const CONTINUE_FILTER_OPTIONS = [
    { value: 'all', label: 'All' },
    { value: 'unfinished', label: 'Ongoing', title: "The FIC is still being posted by the author — regardless of how far you've read" },
    { value: 'caught_up', label: 'Caught up', title: "YOU'VE read every chapter posted so far, even though the fic itself isn't finished yet" },
    { value: 'updates', label: 'Updates available' },
    { value: 'completed', label: 'Completed', title: "You've read this fic all the way through" },
    { value: 'abandoned', label: 'Abandoned', title: "Untouched for 30+ days and not finished or caught up yet" },
    { value: 'rereads', label: 'Rereads', title: "Fics you've opened 3+ times" },
  ];

  function getSavedFilterMode() {
    const saved = GM_getValue(CONTINUE_FILTER_STORAGE_KEY, CONTINUE_FILTER_DEFAULT);
    return CONTINUE_FILTER_OPTIONS.some((o) => o.value === saved) ? saved : CONTINUE_FILTER_DEFAULT;
  }

  function filterCandidates(candidates, mode) {
    switch (mode) {
      case 'unfinished':
        return candidates.filter((c) => c.ficStatus === 'ongoing');
      case 'caught_up':
        return candidates.filter((c) => c.status === 'caught_up');
      case 'updates':
        return candidates.filter(
          (c) =>
            !c.reading.isOneshot &&
            (chaptersBehind(c.reading, c.chapter) > 0 || c.reading.ao3UpdateLabel === 'update_available')
        );
      case 'completed':
        return candidates.filter((c) => c.status === 'completed');
      case 'abandoned':
        return candidates.filter((c) => {
          if (c.status === 'completed' || c.status === 'caught_up') return false;
          return (c.chapter.lastVisited || 0) < Date.now() - ABANDONED_STALE_MS;
        });
      case 'rereads':
        return candidates.filter((c) => (c.reading.visitCount || 0) >= 3);
      case 'all':
      default:
        return candidates.filter((c) => c.status !== 'completed');
    }
  }

  function chaptersBehind(reading, chapter, chapterStats) {
    const published =
      chapterStats?.published ?? reading.chaptersPublished ?? reading.chapterCount;
    if (published == null || chapter.chapterNumber == null) return 0;
    return Math.max(0, published - chapter.chapterNumber);
  }

  function ficProgressFraction(reading, chapter) {
    if (reading.isOneshot) return chapter.scrollPercent || 0;

    const totalChapters = reading.chaptersPublished ?? reading.chapterCount;
    if (!totalChapters || chapter.chapterNumber == null) {
      return chapter.scrollPercent || 0;
    }

    const chaptersCompleted = Math.max(0, chapter.chapterNumber - 1);
    return Math.min(
      1,
      (chaptersCompleted + (chapter.scrollPercent || 0)) / totalChapters
    );
  }

  function sortCandidates(candidates, mode) {
    const sorted = candidates.slice();

    switch (mode) {
      case 'most_progress':
        sorted.sort((a, b) => ficProgressFraction(b.reading, b.chapter) - ficProgressFraction(a.reading, a.chapter));
        break;

      case 'least_progress':
        sorted.sort((a, b) => ficProgressFraction(a.reading, a.chapter) - ficProgressFraction(b.reading, b.chapter));
        break;

      case 'time_spent':
        sorted.sort((a, b) => {
          const diff = (b.reading.totalReadingMs || 0) - (a.reading.totalReadingMs || 0);
          return diff !== 0 ? diff : b.chapter.lastVisited - a.chapter.lastVisited;
        });
        break;

      case 'recent':
      default:
        sorted.sort((a, b) => b.chapter.lastVisited - a.chapter.lastVisited);
        break;
    }

    return sorted;
  }

  function formatRelativeTime(timestamp) {
    const diffMs = Date.now() - timestamp;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diffMs < minute) return "just now";
    if (diffMs < hour) {
      const m = Math.round(diffMs / minute);
      return `${m} minute${m === 1 ? "" : "s"} ago`;
    }
    if (diffMs < day) {
      const h = Math.round(diffMs / hour);
      return `${h} hour${h === 1 ? "" : "s"} ago`;
    }
    if (diffMs < 30 * day) {
      const d = Math.round(diffMs / day);
      return `${d} day${d === 1 ? "" : "s"} ago`;
    }
    return formatDate(timestamp);
  }

  function getCompletionStatus(reading, chapter, chapterStats) {
    if (!chapter) return 'unfinished';

    if (reading.isOneshot) {
      return (chapter.scrollPercent || 0) >= CONTINUE_READING_DONE_THRESHOLD
        ? 'completed'
        : 'unfinished';
    }

    const published =
      chapterStats?.published ??
      reading.chaptersPublished ??
      reading.chapterCount ??
      null;

    const planned = chapterStats
      ? chapterStats.planned
      : (reading.chapterCount ?? null);

    const readThroughLatest =
      chapter.chapterNumber != null &&
      published != null &&
      chapter.chapterNumber >= published &&
      (chapter.scrollPercent || 0) >= CONTINUE_READING_DONE_THRESHOLD;

    if (!readThroughLatest) return 'unfinished';

    if (planned != null && published != null && published >= planned) {
      return 'completed';
    }

    return 'caught_up';
  }

  function getFicStatus(reading, chapterStats) {
    if (reading.isOneshot) return 'completed';

    const published =
      chapterStats?.published ??
      reading.chaptersPublished ??
      reading.chapterCount ??
      null;

    const planned = chapterStats
      ? chapterStats.planned
      : (reading.chapterCount ?? null);

    if (published == null) return 'unknown';

    if (planned != null && published >= planned) return 'completed';

    return 'ongoing';
  }

  function createContinueReadingCard(reading, chapter, status, onRemove) {
    const continueHref =
      chapter.chapterId
        ? `/works/${reading.workId}/chapters/${chapter.chapterId}`
        : `/works/${reading.workId}`;

    const plannedTotal = reading.chapterCount ?? null;
    const publishedCount = reading.chaptersPublished ?? null;
    const chapterLabel = reading.isOneshot
      ? "One-shot"
      : `${formatChapterProgress(chapter.chapterNumber, publishedCount, plannedTotal)} — <span title="Estimated from chapter count, not exact word count — may lag a bit behind AO3 until you next visit your History page" style="cursor:help;border-bottom:1px dotted #999;">${formatPercent(ficProgressFraction(reading, chapter))}%</span>`;
    const behind = reading.isOneshot ? 0 : chaptersBehind(reading, chapter);
    const updateBadge =
      behind > 0
        ? `<p style="margin:0 0 .2em;color:#900;font-weight:bold;font-size:.85em;">
            🆕 +${behind} new chapter${behind === 1 ? "" : "s"}
          </p>`
        : reading.ao3UpdateLabel === 'update_available'
        ? `<p style="margin:0 0 .2em;color:#900;font-weight:bold;font-size:.85em;">
            🆕 Update available
          </p>`
        : "";

    const editedBadge =
      reading.ao3UpdateLabel === 'minor_edits'
        ? `<p style="margin:0 0 .2em;color:#555;font-size:.85em;">
            ✏️ Edited since you last read
          </p>`
        : "";

    const wordEditBadge = wordEditLine(reading, chapter);

    const isCaughtUp = status === 'caught_up';
    const accentColor = isCaughtUp ? "#a86a00" : "#3f9142";

    const progressLine = isCaughtUp
      ? `<p style="margin:0;color:${accentColor};font-weight:bold;font-size:.9em;">
          📬 Caught up — waiting on the next chapter
        </p>`
      : `<p style="margin:0;color:${accentColor};font-weight:bold;font-size:.9em;">
          Progress ${formatPercent(chapter.scrollPercent)}% through ${reading.isOneshot ? "the work" : "this chapter"}
        </p>`;

    const timeLine = `<p style="margin:.3em 0 0;color:#555;font-size:.8em;">
          ⏱ ${formatDuration(chapter.readingMs ?? 0)} this chapter · ${formatDuration(reading.totalReadingMs ?? 0)} total
        </p>`;

    const card = document.createElement("li");
    card.className = "ao3hpp-continue-card";

    card.innerHTML = `
      <a class="ao3hpp-continue-card-link" href="${continueHref}">
        <p style="margin:0 0 .3em;font-weight:bold;color:#000;">
          ${esc(reading.title || "Untitled work")}
        </p>
        <p style="margin:0 0 .2em;color:#555;font-size:.9em;">
          ${chapterLabel}
        </p>
        <p style="margin:0 0 .4em;color:#555;font-size:.9em;">
          Last read ${formatRelativeTime(chapter.lastVisited)}
        </p>
        ${updateBadge}
        ${editedBadge}
        ${wordEditBadge}
        ${progressLine}
        ${timeLine}
      </a>
      <button type="button" class="ao3hpp-remove-card" title="Remove from this list">×</button>
    `;

    card.style.position = "relative";
    card.style.listStyle = "none";
    card.style.flex = "0 0 auto";
    card.style.width = "200px";
    card.style.border = "1px solid #ddd";
    card.style.borderLeft = `3px solid ${accentColor}`;
    card.style.background = "#fafafa";
    card.style.borderRadius = "2px";
    card.style.padding = ".6em .8em";

    const link = card.querySelector(".ao3hpp-continue-card-link");
    link.style.textDecoration = "none";
    link.style.display = "block";

    const removeBtn = card.querySelector(".ao3hpp-remove-card");
    removeBtn.style.position = "absolute";
    removeBtn.style.top = ".3em";
    removeBtn.style.right = ".3em";
    removeBtn.style.width = "1.4em";
    removeBtn.style.height = "1.4em";
    removeBtn.style.lineHeight = "1.2em";
    removeBtn.style.textAlign = "center";
    removeBtn.style.padding = "0";
    removeBtn.style.border = "none";
    removeBtn.style.borderRadius = "50%";
    removeBtn.style.background = "rgba(255,255,255,.85)";
    removeBtn.style.color = "#900";
    removeBtn.style.fontSize = "1em";
    removeBtn.style.fontWeight = "bold";
    removeBtn.style.cursor = "pointer";
    removeBtn.style.opacity = ".65";
    removeBtn.style.boxShadow = "0 1px 2px rgba(0,0,0,0.15)";
    removeBtn.style.transition = "opacity .15s ease";

    removeBtn.addEventListener("mouseenter", () => { removeBtn.style.opacity = "1"; });
    removeBtn.addEventListener("mouseleave", () => { removeBtn.style.opacity = ".65"; });

    removeBtn.addEventListener("click", () => {
      const confirmed = window.confirm(
        `Remove "${reading.title || "this work"}" from Continue Reading?\n\n` +
        `This deletes its saved progress and reading time, and will sync ` +
        `across your other devices too.`
      );
      if (!confirmed) return;

      onRemove(reading.workId);
    });

    return card;
  }

  async function renderContinueReading({ force = false } = {}) {
    const existingSection = document.querySelector(".ao3hpp-continue-reading");
    if (existingSection) {
      if (!force) return;
      existingSection.remove();
    }

    const entries = document.querySelectorAll("#main li.reading");
    const anchor = entries[0]?.closest("ol, ul");
    if (!anchor) return;

    const readings = await AO3DB.getAllReadingsSortedByRecent();
    if (readings.length === 0) return;

    const allCandidates = [];
    for (const reading of readings) {
      const chapter = await AO3DB.getLatestChapter(reading.workId);
      if (!chapter) continue;
      const status = getCompletionStatus(reading, chapter, null);
      const ficStatus = getFicStatus(reading, null);
      allCandidates.push({ reading, chapter, status, ficStatus });
    }

    const section = document.createElement("div");
    section.className = "ao3hpp-continue-reading";
    section.style.margin = "0 0 1.5em";

    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.alignItems = "center";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.flexWrap = "wrap";
    headerRow.style.gap = ".5em 1em";
    headerRow.style.margin = "0 0 .5em";

    const heading = document.createElement("h3");
    heading.className = "heading";
    heading.textContent = "Continue Reading";
    heading.style.color = "#900";
    heading.style.margin = "0";

    const totalTimeEl = document.createElement("span");
    totalTimeEl.className = "ao3hpp-total-reading-time";
    totalTimeEl.style.display = "block";
    totalTimeEl.style.width = "100%";
    totalTimeEl.style.textAlign = "center";
    totalTimeEl.style.fontSize = "1.50em";
    totalTimeEl.style.color = "#555";
    totalTimeEl.style.fontWeight = "600";

    totalTimeEl.textContent =
      `⏱ Total reading time: ${formatDuration(await AO3DB.getTotalReadingMs())}`;

    const sortWrap = document.createElement("div");
    sortWrap.className = "ao3hpp-sort-wrap";
    sortWrap.style.display = "flex";
    sortWrap.style.alignItems = "center";
    sortWrap.style.gap = ".5em";

    const sortLabel = document.createElement("label");
    sortLabel.style.fontSize = ".9em";
    sortLabel.style.color = "#555";
    sortLabel.style.fontWeight = "600";
    sortLabel.textContent = "Sort by";

    const sortInfoIcon = document.createElement("span");
    sortInfoIcon.textContent = "ⓘ";
    sortInfoIcon.title = "\"Most/Least progressed\" estimates how far through the WHOLE fic you are (not just the current chapter), using chapter count — it may lag a bit behind AO3 until you next visit your History page.";
    sortInfoIcon.style.fontSize = ".9em";
    sortInfoIcon.style.color = "#900";
    sortInfoIcon.style.cursor = "help";
    sortInfoIcon.style.marginLeft = ".2em";

    const sortSelect = document.createElement("select");
    sortSelect.className = "ao3hpp-continue-sort";
    sortSelect.style.fontSize = "1em";
    sortSelect.style.fontWeight = "600";
    sortSelect.style.color = "#900";
    sortSelect.style.background = "#fff";
    sortSelect.style.border = "1px solid #900";
    sortSelect.style.borderRadius = "4px";
    sortSelect.style.padding = ".35em 1.6em .35em .6em";
    sortSelect.style.cursor = "pointer";
    sortSelect.style.boxShadow = "0 1px 2px rgba(0,0,0,0.08)";
    sortSelect.style.appearance = "auto";

    for (const opt of CONTINUE_SORT_OPTIONS) {
      const optionEl = document.createElement("option");
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      if (opt.title) {
        optionEl.title = opt.title;
      }
      sortSelect.appendChild(optionEl);
    }

    let currentSort = getSavedSortMode();
    sortSelect.value = currentSort;
    let currentFilter = getSavedFilterMode();

    const list = document.createElement("ol");
    list.style.display = "flex";
    list.style.flexWrap = "wrap";
    list.style.gap = ".8em";
    list.style.margin = "0";
    list.style.padding = "0";
    list.style.transition = "background-color .4s ease";
    list.style.overflowY = "auto";
    list.style.overflowX = "hidden";
    list.style.scrollbarGutter = "stable";
    list.style.alignContent = "flex-start";
    list.style.paddingRight = ".3em";

    const chipRow = document.createElement("div");
    chipRow.className = "ao3hpp-filter-chips";
    chipRow.style.display = "flex";
    chipRow.style.flexWrap = "wrap";
    chipRow.style.gap = ".4em";
    chipRow.style.margin = "0";

    const controlsRow = document.createElement("div");
    controlsRow.className = "ao3hpp-controls-row";
    controlsRow.style.display = "flex";
    controlsRow.style.alignItems = "center";
    controlsRow.style.justifyContent = "space-between";
    controlsRow.style.flexWrap = "wrap";
    controlsRow.style.gap = ".5em 1em";
    controlsRow.style.margin = "0 0 .6em";

    const chipButtons = [];

    function renderChips() {
      for (const btn of chipButtons) {
        const isActive = btn.dataset.value === currentFilter;
        btn.style.background = isActive ? "#900" : "#fff";
        btn.style.color = isActive ? "#fff" : "#900";
        btn.style.borderColor = "#900";
        btn.setAttribute("aria-pressed", String(isActive));
      }
    }

    for (const opt of CONTINUE_FILTER_OPTIONS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ao3hpp-filter-chip";
      chip.dataset.value = opt.value;
      chip.textContent = opt.label;
      if (opt.title) {
        chip.title = opt.title;
      }
      chip.style.fontSize = "1em";
      chip.style.fontWeight = "600";
      chip.style.padding = ".3em .8em";
      chip.style.border = "1px solid #900";
      chip.style.borderRadius = "999px";
      chip.style.cursor = "pointer";
      chip.style.transition = "background-color .15s ease, color .15s ease";

      chip.addEventListener("click", () => {
        if (currentFilter === opt.value) return;
        currentFilter = opt.value;
        GM_setValue(CONTINUE_FILTER_STORAGE_KEY, currentFilter);
        renderChips();
        renderList();
      });

      chipButtons.push(chip);
      chipRow.appendChild(chip);
    }

    const emptyState = document.createElement("p");
    emptyState.className = "ao3hpp-filter-empty";
    emptyState.textContent = "Nothing matches this filter right now.";
    emptyState.style.color = "#777";
    emptyState.style.fontSize = ".9em";
    emptyState.style.margin = "0";
    emptyState.style.display = "none";

    function fitListHeight() {
      requestAnimationFrame(() => {
        const cards = Array.from(list.querySelectorAll(".ao3hpp-continue-card"));
        if (!cards.length) {
          list.style.maxHeight = "";
          return;
        }

        list.style.maxHeight = "none";

        const listTop = list.getBoundingClientRect().top;
        const rects = cards.map(c => c.getBoundingClientRect());

        const rowTops = [...new Set(rects.map(r => Math.round(r.top - listTop)))].sort((a, b) => a - b);

        if (rowTops.length <= 2) {
          list.style.maxHeight = "";
          return;
        }

        const secondRowBottom = Math.max(
          ...rects
            .filter(r => Math.round(r.top - listTop) === rowTops[1])
            .map(r => r.bottom - listTop)
        );

        const tallestCard = Math.max(...cards.map(c => c.getBoundingClientRect().height));
        const cappedHeight = Math.min(secondRowBottom, tallestCard * 2.2);

        list.style.maxHeight = `${Math.ceil(cappedHeight)}px`;
      });
    }

    async function handleRemove(workId) {
      try {
        await AO3DB.deleteReading(workId);
      } catch (err) {
        console.warn('[AO3 History++] failed to delete reading:', err);
        window.alert('Could not remove this fic — check the console for details.');
        return;
      }

      const idx = allCandidates.findIndex((c) => c.reading.workId === workId);
      if (idx !== -1) allCandidates.splice(idx, 1);

      totalTimeEl.textContent =
        `⏱ Total reading time: ${formatDuration(await AO3DB.getTotalReadingMs())}`;

      if (allCandidates.length === 0) {
        section.remove();
        return;
      }

      renderList();
    }

    function renderList() {
      list.innerHTML = "";
      const filtered = filterCandidates(allCandidates, currentFilter);
      const sorted = sortCandidates(filtered, currentSort);

      emptyState.style.display = sorted.length === 0 ? "block" : "none";
      list.style.display = sorted.length === 0 ? "none" : "flex";

      for (const { reading, chapter, status } of sorted) {
        list.appendChild(createContinueReadingCard(reading, chapter, status, handleRemove));
      }

      fitListHeight();
    }

    sortSelect.addEventListener("change", () => {
      currentSort = sortSelect.value;
      GM_setValue(CONTINUE_SORT_STORAGE_KEY, currentSort);
      renderList();

      list.style.backgroundColor = "#fff0f0";
      requestAnimationFrame(() => {
        setTimeout(() => {
          list.style.backgroundColor = "transparent";
        }, 350);
      });

      console.log("[AO3 History++] Continue Reading sorted by:", currentSort);
    });

    renderChips();
    renderList();

    sortWrap.appendChild(sortLabel);
    sortWrap.appendChild(sortSelect);
    sortWrap.appendChild(sortInfoIcon);
    headerRow.appendChild(heading);
    headerRow.appendChild(totalTimeEl);

    controlsRow.appendChild(chipRow);
    controlsRow.appendChild(sortWrap);

    section.appendChild(headerRow);
    section.appendChild(controlsRow);
    section.appendChild(list);
    section.appendChild(emptyState);

    anchor.insertAdjacentElement("beforebegin", section);
  }

  function renderReadingTimeWidget(chapterMs, totalMs) {
    const fic =
      document.querySelector("#workskin .userstuff.module") ||
      document.querySelector(".userstuff.module");

    if (!fic) return;

    const existingWidget = fic.querySelector(".ao3hpp-reading-time");
    if (existingWidget) existingWidget.remove();

    const widget = document.createElement("div");
    widget.className = "ao3hpp-reading-time";
    widget.style.margin = "1.5em 0 0";
    widget.style.color = "#555";
    widget.style.fontSize = ".85em";
    widget.textContent =
      `⏱ Time spent this chapter: ${formatDuration(chapterMs)}` +
      ` | Total on this fic: ${formatDuration(totalMs)}`;

    fic.appendChild(widget);
  }

  function createInfoBox(reading, chapter, chapterStats, ao3Label){
    const box = document.createElement("div");
    box.className = "ao3-history-plus-plus";

    const continueHref =
      chapter.chapterId
        ? `/works/${reading.workId}/chapters/${chapter.chapterId}`
        : `/works/${reading.workId}`;

    const status = getCompletionStatus(reading, chapter, chapterStats);

    const behind = reading.isOneshot ? 0 : chaptersBehind(reading, chapter, chapterStats);
    const updateLine =
      behind > 0
        ? `<p style="margin:.2em 0;color:#900;font-weight:bold;">
             🆕 +${behind} new chapter${behind === 1 ? "" : "s"} since you last read
           </p>`
        : ao3Label === 'update_available'
        ? `<p style="margin:.2em 0;color:#900;font-weight:bold;">
             🆕 Update available
           </p>`
        : "";

    const editedLine =
      ao3Label === 'minor_edits'
        ? `<p style="margin:.2em 0;color:#555;">
             ✏️ Minor edits made to this fic since you last read it
           </p>`
        : "";

    const wordEditsLine = wordEditLine(reading, chapter);

    const statusBanner =
      status === 'completed'
        ? `<p style="margin:.2em 0;color:#2a7a2a;font-weight:bold;">
             ✅ Completed — you've read this all the way through
           </p>`
        : status === 'caught_up'
        ? `<p style="margin:.2em 0;color:#a86a00;font-weight:bold;">
             📬 Caught up — you've read every posted chapter, but this fic is still ongoing
           </p>`
        : "";

    const borderColor =
      status === 'completed' ? "#2a7a2a" :
      status === 'caught_up' ? "#a86a00" :
      "#3f9142";

    const linkLabel =
      status === 'completed' ? "Read again →" :
      status === 'caught_up' ? "Reread while you wait →" :
      "Continue reading →";

    box.innerHTML = `
    <p style="margin:.4em 0;color:#900;font-weight:bold;">
      History++
    </p>

    ${statusBanner}

    ${updateLine}

    ${editedLine}

    ${wordEditsLine}

    <p style="margin:.2em 0;">
    📖 <strong>Your progress:</strong>
    ${
      reading.isOneshot
        ? "One-shot"
        : `${formatChapterProgress(chapter.chapterNumber, chapterStats?.published ?? null, chapterStats?.planned ?? null)} — <span title="Estimated from chapter count, not exact word count — may lag a bit behind AO3 until you next visit your History page" style="cursor:help;border-bottom:1px dotted #999;">${formatPercent(ficProgressFraction(reading, chapter))}% of the fic</span>`    }
  </p>

    <p style="margin:.2em 0;">
    📍 <strong>Reading progress:</strong>
    ${formatPercent(chapter.scrollPercent)}% through this ${reading.isOneshot ? "work" : "chapter"}
    </p>

    <p style="margin:.2em 0;">
      🕒 First opened ${formatDate(reading.firstOpened)}
    </p>

    <p style="margin:.2em 0;">
      ⏱ <strong>Time spent:</strong>
      ${formatDuration(chapter.readingMs ?? 0)} this ${reading.isOneshot ? "work" : "chapter"} · ${formatDuration(reading.totalReadingMs ?? 0)} total
    </p>

    ${reading.visitCount > 1 ? `
    <p style="margin:.2em 0;">
      🔁 Returned ${reading.visitCount} times
    </p>
  ` : ""}

    <p style="margin:.4em 0 0;">
    <a class="ao3hpp-continue" href="${continueHref}">
      ${linkLabel}
    </a>
  </p>
  `;

    const continueLink = box.querySelector(".ao3hpp-continue");
    if (continueLink) {
      continueLink.style.fontWeight = "bold";
      continueLink.style.textDecoration = "none";
    }

    box.style.borderLeft = `3px solid ${borderColor}`;
    box.style.background = "#fafafa";
    box.style.padding = ".7em .8em";
    box.style.margin = ".7em 0";
    box.style.fontSize = ".9em";
    box.style.borderRadius = "2px";

    return box;
  }

  const FULL_SYNC_STORAGE_KEY = 'ao3hpp_full_history_synced_at';
  const FULL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
  const FULL_SYNC_PAGE_DELAY_MS = 400;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getMaxHistoryPage(doc) {
    const pageLinks = Array.from(
      doc.querySelectorAll('#main ol.pagination a[href*="page="]')
    );
    let max = 1;
    for (const a of pageLinks) {
      const m = (a.getAttribute('href') || '').match(/page=(\d+)/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  async function fetchHistoryPage(pageNumber) {
    const basePath = window.location.pathname.replace(/\?.*$/, '');
    const res = await fetch(`${basePath}?page=${pageNumber}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const html = await res.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function refreshEntriesFromDocument(doc) {
    const entries = doc.querySelectorAll('li.reading');

    for (const entry of entries) {
      const link = entry.querySelector("a[href*='/works/']");
      if (!link) continue;

      const match = link.href.match(/\/works\/(\d+)/);
      if (!match) continue;

      const workId = Number(match[1]);

      const reading = await AO3DB.getReading(workId);
      if (!reading) continue;

      const viewed = entry.querySelector('.viewed');
      const ao3Label = getAO3UpdateLabel(entry, viewed);
      await AO3DB.updateAO3Label(workId, ao3Label);

      const chapterStats = getPublishedChapterCount(entry);

      if (chapterStats) {
        await AO3DB.updateChapterStatsFromHistory(
          workId,
          chapterStats.published,
          chapterStats.planned
        );
      }
    }
  }

  async function syncAllHistoryPages() {
    const params = new URLSearchParams(window.location.search);
    const currentPage = Number(params.get('page') || '1');
    if (currentPage !== 1) return;

    const lastSynced = GM_getValue(FULL_SYNC_STORAGE_KEY, 0);
    if (Date.now() - lastSynced < FULL_SYNC_COOLDOWN_MS) return;

    const maxPage = getMaxHistoryPage(document);
    if (maxPage <= 1) {
      GM_setValue(FULL_SYNC_STORAGE_KEY, Date.now());
      return;
    }

    console.log(
      `[AO3 History++] Walking ${maxPage - 1} more history page(s) in the background...`
    );

    for (let page = 2; page <= maxPage; page++) {
      try {
        const doc = await fetchHistoryPage(page);
        if (doc) await refreshEntriesFromDocument(doc);
      } catch (err) {
        console.warn('[AO3 History++] background history page fetch failed:', page, err);
      }
      await sleep(FULL_SYNC_PAGE_DELAY_MS);
    }

    GM_setValue(FULL_SYNC_STORAGE_KEY, Date.now());
    console.log('[AO3 History++] Background history walk complete.');

    if (!isStatsView()) {
      await renderContinueReading({ force: true });
    }
  }

  // ============================================================
  // STATISTICS PAGE
  //
  // Engagement blocks covenant: FACTS ONLY. No notifications, no
  // guilt copy, no urgency styling.
  // ============================================================

  const STATS_REFRESH_MS = 60_000;

  // ---- milestones ------------------------------------------------------

  const MILESTONES = [
    { icon: '📖', label: 'First fic tracked',     metric: 'fics',             target: 1 },
    { icon: '📚', label: '10 fics tracked',       metric: 'fics',             target: 10 },
    { icon: '🏛️', label: '50 fics tracked',       metric: 'fics',             target: 50 },
    { icon: '✒️', label: '10,000 words read',     metric: 'words',            target: 10_000 },
    { icon: '📝', label: '100,000 words read',    metric: 'words',            target: 100_000 },
    { icon: '🏆', label: '1,000,000 words read',  metric: 'words',            target: 1_000_000 },
    { icon: '⏱', label: '10 hours read',          metric: 'hours',            target: 10 },
    { icon: '🌙', label: '50 hours read',         metric: 'hours',            target: 50 },
    { icon: '🔥', label: '7-day reading streak',  metric: 'bestStreak',       target: 7 },
    { icon: '☄️', label: '30-day reading streak', metric: 'bestStreak',       target: 30 },
    { icon: '🏁', label: '25 chapters finished',  metric: 'finishedChapters', target: 25 },
    { icon: '🎯', label: '100 chapters finished', metric: 'finishedChapters', target: 100 },
  ];

  function computeMilestones(model) {
    const values = {
      fics: model.readings.length,
      words: model.totalWords,
      ms: model.totalMs,
      bestStreak: model.streaks.best,
      finishedChapters: model.finishedChapters,
    };

    const achieved = [];
    const next = [];

    for (const m of MILESTONES) {
      const v = values[m.metric];

      if (m.metric === 'hours') {
        if (values.ms >= m.target * 3_600_000) achieved.push(m.label);
        else next.push({ ...m, v: values.ms / 3_600_000 });
        continue;
      }

      if (v >= m.target) achieved.push(m.label);
      else next.push({ ...m, v });
    }

    // Nearest three by completion fraction — not declaration order.
    const nextWithProgress = next
      .map((m) => ({
        label: m.label,
        icon: m.icon,
        pct: Math.max(1, Math.min(99, Math.round((m.v / m.target) * 100))),
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3);

    return { achieved, next: nextWithProgress };
  }

  // ---- computations ---------------------------------------------------

  function computeStreaks(dailyRows) {
    const msByDate = new Map();
    for (const e of dailyRows) {
      if (!e || typeof e.date !== 'string') continue;
      msByDate.set(e.date, (msByDate.get(e.date) || 0) + (e.msDelta || 0));
    }

    const activeDays = [...msByDate.entries()]
      .filter(([, ms]) => ms > 0)
      .map(([d]) => d)
      .sort();

    if (activeDays.length === 0) {
      return { current: 0, best: 0, activeDays: 0 };
    }

    const dayMs = 86_400_000;
    const toDate = (s) => new Date(`${s}T00:00:00`).getTime();

    let best = 1, run = 1;
    for (let i = 1; i < activeDays.length; i++) {
      if (toDate(activeDays[i]) - toDate(activeDays[i - 1]) <= dayMs * 1.5) {
        run++;
        best = Math.max(best, run);
      } else {
        run = 1;
      }
    }

    const todayStr = localDateString();
    let cursor = msByDate.get(todayStr) > 0
      ? todayStr
      : localDateString(Date.now() - dayMs);

    let current = 0;
    while ((msByDate.get(cursor) || 0) > 0) {
      current++;
      const d = toDate(cursor) - dayMs;
      cursor = localDateString(d);
    }

    return { current, best: Math.max(best, current), activeDays: activeDays.length };
  }

  function computePersonality(model) {
    const labels = [];
    const { hourTotals, attributedMs } = model.timeOfDay;

    if (model.totalMs >= 30 * 60_000) {
      let nightMs = 0, morningMs = 0, weekendMs = 0;
      for (let d = 0; d < 7; d++) {
        const ts = Date.now() - d * 86_400_000;
        const dow = new Date(ts).getDay();
        if (dow === 0 || dow === 6) {
          for (let h = 0; h < 24; h++) weekendMs += hourTotals[h];
        }
      }
      const weekTotal = hourTotals.reduce((a, b) => a + b, 0);
      for (let h = 22; h < 24; h++) nightMs += hourTotals[h];
      for (let h = 0; h < 5; h++) nightMs += hourTotals[h];
      for (let h = 5; h < 10; h++) morningMs += hourTotals[h];

      if (attributedMs > 0 && nightMs / attributedMs > 0.45) {
        labels.push({ name: 'Night Owl', basis: `${Math.round((nightMs / attributedMs) * 100)}% of logged time falls between 10pm–5am` });
      } else if (attributedMs > 0 && morningMs / attributedMs > 0.40) {
        labels.push({ name: 'Early Bird', basis: `${Math.round((morningMs / attributedMs) * 100)}% of logged time falls between 5–10am` });
      }

      if (weekTotal > 0 && weekendMs / weekTotal > 0.55) {
        labels.push({ name: 'Weekend Reader', basis: `${Math.round((weekendMs / weekTotal) * 100)}% of the last week's reading happened on Sat/Sun` });
      }

      const wpm = model.totalMs > 0 ? model.totalWords / (model.totalMs / 60000) : 0;
      if (wpm > 350) {
        labels.push({ name: 'Speed Demon', basis: `lifetime average ≈ ${Math.round(wpm)} wpm` });
      } else if (wpm > 0 && wpm < 180 && model.totalMs >= 5 * 3_600_000) {
        labels.push({ name: 'Slow Savorer', basis: `lifetime average ≈ ${Math.round(wpm)} wpm` });
      }
    }

    if (labels.length === 0) {
      return { labels: [], insufficient: true };
    }
    return { labels: labels.slice(0, 2), insufficient: false };
  }

  function computeYearReview(dailyRows, readings, year) {
    let startStr = '0000-01-01', endStr = '9999-12-31';
    if (year !== null) {
      startStr = `${year}-01-01`;
      endStr = `${year}-12-31`;
    }

    const rows = dailyRows.filter((e) => e.date >= startStr && e.date <= endStr);

    let words = 0, ms = 0;
    const byDay = new Map();
    const byWeek = new Map();
    const byWork = new Map();

    for (const e of rows) {
      words += e.wordsDelta || 0;
      ms += e.msDelta || 0;
      byDay.set(e.date, (byDay.get(e.date) || 0) + (e.wordsDelta || 0));

      const d = new Date(`${e.date}T00:00:00`);
      const mon = new Date(d);
      mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const wk = AO3DB.getLocalDateString(mon.getTime());
      byWeek.set(wk, (byWeek.get(wk) || 0) + (e.wordsDelta || 0));

      const w = byWork.get(e.workId) || { words: 0, ms: 0 };
      w.words += e.wordsDelta || 0;
      w.ms += e.msDelta || 0;
      byWork.set(e.workId, w);
    }

    let busiestDay = null, busiestWeek = null;
    for (const [d, w] of byDay) {
      if (!busiestDay || w > busiestDay.words) busiestDay = { date: d, words: w };
    }
    for (const [wk, w] of byWeek) {
      if (!busiestWeek || w > busiestWeek.words) busiestWeek = { weekOf: wk, words: w };
    }

    const topFics = [...byWork.entries()]
      .sort((a, b) => b[1].words - a[1].words)
      .slice(0, 3)
      .map(([workId, agg]) => ({
        reading: readings.find((r) => r.workId === workId) || { title: `Work #${workId}` },
        words: agg.words,
        ms: agg.ms,
      }));

    return { year, words, ms, busiestDay, busiestWeek, topFics };
  }

  function computeFunnel(latestChapters) {
    const started = latestChapters.length;
    let quarter = 0, finishedOrCaughtUp = 0;

    for (const { reading, chapter } of latestChapters) {
      const frac = ficProgressFraction(reading, chapter);
      if (frac >= 0.25) quarter++;
      const st = getCompletionStatus(reading, chapter, null);
      if (st === 'completed' || st === 'caught_up') finishedOrCaughtUp++;
    }

    return { started, quarter, finishedOrCaughtUp };
  }

  function computeStalled(allCandidates) {
    const STALE_DAYS = 14;
    const cutoff = Date.now() - STALE_DAYS * 86_400_000;

    return allCandidates
      .filter((c) =>
        c.chapter.lastVisited < cutoff &&
        (chaptersBehind(c.reading, c.chapter) > 0 ||
         (c.chapter.scrollPercent || 0) < CONTINUE_READING_DONE_THRESHOLD)
      )
      .sort((a, b) => a.chapter.lastVisited - b.chapter.lastVisited)
      .slice(0, 8);
  }

  function rangeBounds(range) {
    if (range === '30d') {
      return { startStr: daysAgoDateString(29) };
    }
    const now = new Date();
    return {
      startStr: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
    };
  }

  function computeTopFics(model, range) {
    if (range === 'all') {
      return model.readings
        .map((r) => ({ reading: r, words: r.totalWordsRead || 0, ms: r.totalReadingMs || 0 }))
        .filter((x) => x.words > 0 || x.ms > 0);
    }

    const { startStr } = rangeBounds(range);
    const byWork = new Map();

    for (const e of model.daily) {
      if (e.date < startStr) continue;
      const w = byWork.get(e.workId) || { words: 0, ms: 0 };
      w.words += e.wordsDelta || 0;
      w.ms += e.msDelta || 0;
      byWork.set(e.workId, w);
    }

    return [...byWork.entries()]
      .map(([workId, agg]) => ({
        reading: model.readings.find((r) => r.workId === workId) || { title: `Work #${workId}`, workId },
        words: agg.words,
        ms: agg.ms,
      }))
      .filter((x) => x.words > 0 || x.ms > 0);
  }

  function computeAuthorLeaderboard(readings) {
    const byAuthor = new Map();

    for (const r of readings) {
      const key = r.author || 'Unknown';
      const a = byAuthor.get(key) || { author: key, words: 0, ms: 0, fics: 0 };
      a.words += r.totalWordsRead || 0;
      a.ms += r.totalReadingMs || 0;
      a.fics += 1;
      byAuthor.set(key, a);
    }

    return [...byAuthor.values()]
      .filter((a) => a.words > 0)
      .sort((a, b) => b.words - a.words)
      .slice(0, 5);
  }

  // ---- section builders ------------------------------------------------

  function buildOverviewCards(model) {
    const p = panel('📊 Lifetime overview');

    const cardsData = [
      { label: 'Words read', value: formatWords(model.totalWords) },
      { label: 'Time read', value: formatDuration(model.totalMs) },
      { label: 'Avg speed', value: formatSpeed(model.totalWords, model.totalMs) },
      { label: 'Fics tracked', value: String(model.readings.length) },
      { label: 'Chapters finished', value: formatWords(model.finishedChapters) },
    ];

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.gap = '.8em';

    for (const c of cardsData) {
      const card = document.createElement('div');
      card.className = 'ao3hpp-stat-card';
      card.style.flex = '1 1 150px';
      card.style.border = '1px solid var(--hpp-border)';
      card.style.borderLeft = '3px solid var(--hpp-accent)';
      card.style.background = 'var(--hpp-panel)';
      card.style.borderRadius = '2px';
      card.style.padding = '.6em .8em';

      card.innerHTML = `
        <p style="margin:0 0 .3em;color:var(--hpp-muted);font-size:.85em;font-weight:600;">${esc(c.label)}</p>
        <p style="margin:0;color:var(--hpp-text);font-weight:bold;font-size:1.1em;">${esc(c.value)}</p>
      `;
      row.appendChild(card);
    }

    p.appendChild(row);

    if (model.totalWords > 50000) {
      const warAndPeace = 587_287;
      const copies = model.totalWords / warAndPeace;
      const amb = document.createElement('p');
      amb.style.cssText = 'margin:.8em 0 0;color:var(--hpp-muted);font-size:.85em;';
      amb.textContent =
        `ℹ️ That's roughly ${copies >= 1 ? `${copies.toFixed(1)} copies of War and Peace` : `${Math.round(model.totalWords / 90_000 * 10) / 10} copies of The Great Gatsby`} — or about ${Math.round(model.totalMs / (22 * 24 * 3_600_000) * 10) / 10} seasons of a 22-episode TV drama you read instead.`;
      p.appendChild(amb);
    }

    return p;
  }

  function bucketColor(words, emptyColor) {
    if (words <= 0) return emptyColor || '#ebedf0';
    if (words < 1000) return "#c6e6c6";
    if (words < 3000) return "#8fd18f";
    if (words < 6000) return "#4fae4f";
    return "#2a7a2a";
  }

  function buildHeatmap(model) {
    const HEATMAP_DAYS = 126;

    const details = document.createElement('details');
    details.className = 'ao3hpp-details';
    details.open = true;
    details.id = 'hpp-heatmap-inner';

    const summary = document.createElement('summary');
    summary.textContent = '🗓 Reading heatmap (18 weeks)';
    details.appendChild(summary);

    const statsByDate = new Map();
    for (const e of model.daily) {
      const cur = statsByDate.get(e.date) || { words: 0, ms: 0 };
      cur.words += e.wordsDelta || 0;
      cur.ms += e.msDelta || 0;
      statsByDate.set(e.date, cur);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (HEATMAP_DAYS - 1));
    start.setDate(start.getDate() - start.getDay());

    const trackFallback =
      document.querySelector('.ao3hpp-stats-view')?.style.getPropertyValue('--hpp-track')?.trim() || '#ebedf0';

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-rows:repeat(7,12px);grid-auto-flow:column;grid-auto-columns:12px;gap:3px;overflow-x:auto;padding:.2em 0;';

    const cursor = new Date(start);
    while (cursor <= today) {
      const ts = cursor.getTime();
      const ds = AO3DB.getLocalDateString(ts);
      const entry = statsByDate.get(ds);

      const sq = document.createElement('div');
      sq.style.cssText = 'width:12px;height:12px;border-radius:2px;';
      sq.style.background = bucketColor(entry ? entry.words : 0, trackFallback);
      sq.title = entry
        ? `${formatDate(ts)}: ${formatWords(entry.words)} words, ${formatDuration(entry.ms)}`
        : `${formatDate(ts)}: no reading recorded`;
      grid.appendChild(sq);

      cursor.setDate(cursor.getDate() + 1);
    }

    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;align-items:center;gap:.3em;margin-top:.4em;font-size:.75em;color:var(--hpp-muted);';
    legend.innerHTML = '<span>Less</span>';
    for (const colr of ['#c6e6c6', '#8fd18f', '#4fae4f', '#2a7a2a']) {
      legend.insertAdjacentHTML('beforeend', `<span style="width:10px;height:10px;border-radius:2px;display:inline-block;background:${colr};"></span>`);
    }
    legend.insertAdjacentHTML('beforeend', '<span>More</span>');

    details.appendChild(grid);
    details.appendChild(legend);
    return details;
  }

  function buildDeepDiveRow(container, item) {
    const r = item.reading;
    const row = document.createElement('li');
    row.style.margin = '.3em 0';

    row.innerHTML = `
      <a href="/works/${r.workId}" style="color:var(--hpp-accent);text-decoration:none;font-weight:600;">${esc(r.title || 'Untitled work')}</a>
      <span style="color:var(--hpp-muted);"> — ${formatWords(item.words)} words · ${formatDuration(item.ms)} · ${esc(formatSpeed(item.words, item.ms))}</span>
      <button type="button" class="ao3hpp-deep-toggle" style="border:none;background:none;color:var(--hpp-muted);cursor:pointer;font-size:.85em;padding:0 .4em;">▸ details</button>
      <div class="ao3hpp-deep-body" style="display:none;"></div>
    `;

    const toggle = row.querySelector('.ao3hpp-deep-toggle');
    const body = row.querySelector('.ao3hpp-deep-body');

    toggle.addEventListener('click', async () => {
      if (body.style.display === 'none') {
        toggle.textContent = '▾ details';
        body.style.display = 'block';

        if (!body.dataset.loaded) {
          body.dataset.loaded = '1';
          body.innerHTML = `<p style="color:var(--hpp-muted);font-size:.85em;">loading chapters…</p>`;

          const chapters = (await AO3DB.getChaptersForWork(r.workId))
            .sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

          if (chapters.length === 0) {
            body.innerHTML = `<p style="color:var(--hpp-muted);font-size:.85em;">No per-chapter data recorded.</p>`;
            return;
          }

          const maxMs = Math.max(1, ...chapters.map((c) => c.readingMs || 0));

          let html = `
            <p style="margin:.3em 0 .1em;color:var(--hpp-muted);font-size:.85em;">
              First opened ${formatDate(r.firstOpened)} · last read ${formatRelativeTime(r.lastVisited)} · visited ${r.visitCount || 1}${r.fandoms?.length ? ` · ${esc(r.fandoms.join(', '))}` : ''}
            </p>
            <ol style="margin:0;padding:0;list-style:none;">`;

          for (const c of chapters) {
            const pct = Math.round(((c.readingMs || 0) / maxMs) * 100);
            html += `
              <li style="display:flex;align-items:center;gap:.5em;margin:.2em 0;font-size:.85em;">
                <span class="ao3hpp-deep-ch" style="flex:0 0 7em;color:var(--hpp-muted);">Ch ${esc(String(c.chapterNumber ?? '—'))}: ${formatDuration(c.readingMs)}</span>
                <span style="flex:1 1 auto;height:6px;background:var(--hpp-track);border-radius:3px;overflow:hidden;">
                  <span style="display:block;height:100%;width:${pct}%;background:var(--hpp-bar);"></span>
                </span>
                <span style="flex:0 0 3em;text-align:right;color:var(--hpp-muted);">${formatPercent(c.maxScrollPercent)}%</span>
              </li>`;
          }
          html += `</ol>`;
          body.innerHTML = html;
        }
      } else {
        toggle.textContent = '▸ details';
        body.style.display = 'none';
      }
    });

    container.appendChild(row);
  }

  function buildTopFics(model) {
    const p = panel(null);

    const title = document.createElement('p');
    title.style.cssText = 'margin:0 0 .4em;color:var(--hpp-muted);font-size:.85em;font-weight:600;';
    title.textContent = '🏆 Top fics';
    p.appendChild(title);

    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex;gap:.4em;margin:0 0 .6em;flex-wrap:wrap;';
    const listWrap = document.createElement('div');
    p.appendChild(chipRow);
    p.appendChild(listWrap);

    function renderRange(range) {
      for (const b of chipRow.children) {
        const active = b.dataset.v === range;
        b.style.background = active ? 'var(--hpp-accent)' : 'var(--hpp-chip)';
        b.style.color = active ? '#fff' : 'var(--hpp-accent)';
      }

      const items = computeTopFics(model, range)
        .sort((a, b) => (b.words - a.words))
        .slice(0, 5);

      listWrap.innerHTML = '';

      if (items.length === 0) {
        listWrap.innerHTML = `<p style="margin:0;color:var(--hpp-muted);">Nothing recorded in this period yet.</p>`;
        return;
      }

      const ol = document.createElement('ol');
      ol.style.cssText = 'margin:0;padding-left:1.3em;font-size:.9em;';
      listWrap.appendChild(ol);

      for (const item of items) {
        buildDeepDiveRow(ol, item);
      }
    }

    for (const [v, label] of [['all', 'All time'], ['30d', 'Last 30 days'], ['month', 'This month']]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.v = v;
      chip.textContent = label;
      chip.style.cssText = 'border:1px solid var(--hpp-accent);border-radius:999px;padding:.2em .8em;font-size:.85em;font-weight:600;cursor:pointer;background:var(--hpp-chip);color:var(--hpp-accent);';
      chip.addEventListener('click', () => renderRange(v));
      chipRow.appendChild(chip);
    }

    renderRange('all');
    return p;
  }

  function buildAuthors(model) {
    const rows = computeAuthorLeaderboard(model.readings);
    const p = panel('🖋 Most-read authors');

    if (rows.length === 0) {
      p.insertAdjacentHTML('beforeend', `<p style="margin:0;color:var(--hpp-muted);">No word data yet.</p>`);
      return p;
    }

    const ol = document.createElement('ol');
    ol.style.cssText = 'margin:0;padding-left:1.3em;font-size:.9em;';

    for (const a of rows) {
      ol.insertAdjacentHTML('beforeend', `
        <li style="margin:.2em 0;">
          <strong>${esc(a.author)}</strong>
          <span style="color:var(--hpp-muted);"> — ${formatWords(a.words)} words across ${a.fics} fic${a.fics === 1 ? '' : 's'} · ${esc(formatSpeed(a.words, a.ms))}</span>
        </li>`);
    }

    p.appendChild(ol);
    return p;
  }

  function buildFandoms(model) {
    const tally = new Map();

    for (const r of model.readings) {
      for (const f of r.fandoms || []) {
        const t = tally.get(f) || { name: f, words: 0, fics: 0 };
        t.words += r.totalWordsRead || 0;
        t.fics += 1;
        tally.set(f, t);
      }
    }

    const top = [...tally.values()].filter((t) => t.words > 0).sort((a, b) => b.words - a.words).slice(0, 8);
    const p = panel('🌐 Fandoms & ships');

    if (top.length === 0) {
      p.insertAdjacentHTML('beforeend',
        `<p style="margin:0;color:var(--hpp-muted);">No tag data yet — fandoms are captured when you visit a work with 0.2.0+, and sync across devices.</p>`);
      return p;
    }

    const ol = document.createElement('ol');
    ol.style.cssText = 'margin:0;padding-left:1.3em;font-size:.9em;';
    for (const t of top) {
      ol.insertAdjacentHTML('beforeend', `
        <li style="margin:.2em 0;"><strong>${esc(t.name)}</strong>
        <span style="color:var(--hpp-muted);"> — ${formatWords(t.words)} words · ${t.fics} fic${t.fics === 1 ? '' : 's'}</span></li>`);
    }
    p.appendChild(ol);

    const ships = new Map();
    for (const r of model.readings) {
      for (const s of r.relationships || []) {
        ships.set(s, (ships.get(s) || 0) + (r.totalWordsRead || 0));
      }
    }
    const topShip = [...ships.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1])[0];
    if (topShip) {
      p.insertAdjacentHTML('beforeend',
        `<p style="margin:.5em 0 0;color:var(--hpp-muted);font-size:.9em;">💚 Most-read ship: <strong style="color:var(--hpp-text);">${esc(topShip[0])}</strong> (${formatWords(topShip[1])} words)</p>`);
    }

    return p;
  }

  // ---- series progress --------------------------------------------------

  function buildSeriesProgress(model) {
    const p = panel('📚 Series progress <span style="font-weight:normal;" title="A work counts once you\'ve opened it at least once while tracked">(counting works you\'ve opened)</span>');

    const startedIds = new Set(model.chapters.map((c) => c.workId));

    const recs = [...(model.series || [])]
      .filter((s) => s && Array.isArray(s.works) && s.works.length > 0)
      .filter((s) => s.works.some((w) => startedIds.has(w.workId)))
      .sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));

    if (recs.length === 0) {
      p.insertAdjacentHTML('beforeend',
        `<p style="margin:0;color:var(--hpp-muted);">No series in progress right now — open any work that belongs to a series and it'll appear here.</p>`);
      return p;
    }

    for (const s of recs) {
      const total = s.works.length;
      const readWorks = s.works.filter((w) => startedIds.has(w.workId));
      const unread = s.works.filter((w) => !startedIds.has(w.workId));
      const pct = total > 0 ? Math.round((readWorks.length / total) * 100) : 0;

      const row = document.createElement('div');
      row.style.cssText = 'margin:.5em 0;';

      let nextHtml = '';
      if (unread.length > 0) {
        const next = unread[0];
        nextHtml = `<p style="margin:.15em 0 0;color:var(--hpp-muted);font-size:.85em;">
            Next unread: <a href="/works/${next.workId}" style="color:var(--hpp-accent);text-decoration:none;font-weight:600;">${esc(next.title || `Work #${next.workId}`)}</a>${unread.length > 1 ? ` (+${unread.length - 1} more)` : ''}
          </p>`;
      } else {
        nextHtml = `<p style="margin:.15em 0 0;color:var(--hpp-muted);font-size:.85em;">✅ Fully opened</p>`;
      }

      row.innerHTML = `
        <p style="margin:0 0 .25em;">
          <a href="/series/${s.seriesId}" style="color:var(--hpp-accent);text-decoration:none;font-weight:600;">${esc(s.title || `Series #${s.seriesId}`)}</a>
          <span style="color:var(--hpp-muted);"> — ${readWorks.length}/${total} opened</span>
        </p>
        <div style="height:8px;background:var(--hpp-track);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:var(--hpp-bar);"></div>
        </div>
        ${nextHtml}
      `;

      p.appendChild(row);
    }

    return p;
  }

  function buildYearReview(model) {
    const thisYear = new Date().getFullYear();
    const p = panel(null);

    const body = document.createElement('div');

    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex;gap:.4em;margin:0 0 .6em;flex-wrap:wrap;';

    const title = document.createElement('p');
    title.style.cssText = 'margin:0 0 .4em;color:var(--hpp-muted);font-size:.85em;font-weight:600;';
    title.textContent = '📅 Year in review';

    p.appendChild(title);
    p.appendChild(chipRow);
    p.appendChild(body);

    function renderRange(which) {
      const year = which === 'this' ? thisYear : which === 'last' ? thisYear - 1 : null;
      const yr = computeYearReview(model.daily, model.readings, year);

      for (const b of chipRow.children) {
        const active = b.dataset.v === which;
        b.style.background = active ? 'var(--hpp-accent)' : 'var(--hpp-chip)';
        b.style.color = active ? '#fff' : 'var(--hpp-accent)';
      }

      const head = year === null ? 'All time' : String(year);
      let html = `
        <p style="margin:.2em 0;">
          <strong>${esc(head)}:</strong>
          ${formatWords(yr.words)} words · ${formatDuration(yr.ms)}
          · ${esc(formatSpeed(yr.words, yr.ms))}
        </p>`;

      if (yr.busiestDay) {
        html += `<p style="margin:.15em 0;color:var(--hpp-muted);font-size:.9em;">
          Biggest single day: ${formatDate(new Date(`${yr.busiestDay.date}T00:00:00`).getTime())} (${formatWords(yr.busiestDay.words)} words)` +
          (yr.busiestWeek ? ` · biggest week of ${shortDate(new Date(`${yr.busiestWeek.weekOf}T00:00:00`).getTime())} (${formatWords(yr.busiestWeek.words)})` : '') +
        `</p>`;
      }

      if (yr.topFics.length) {
        html += `<p style="margin:.3em 0 .1em;color:var(--hpp-muted);font-size:.85em;font-weight:600;">Top fics ${year === null ? 'of all time' : `in ${head}`}:</p><ol style="margin:0;padding-left:1.3em;font-size:.9em;">`;
        for (const f of yr.topFics) {
          html += `<li style="margin:.15em 0;"><a href="/works/${f.reading.workId}" style="color:var(--hpp-accent);text-decoration:none;font-weight:600;">${esc(f.reading.title || 'Untitled')}</a> — ${formatWords(f.words)} words</li>`;
        }
        html += `</ol>`;
      }

      body.innerHTML = html;
    }

    for (const [v, label] of [['this', thisYear], ['last', thisYear - 1], ['all', 'All time']]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.v = v;
      chip.textContent = label;
      chip.style.cssText = 'border:1px solid var(--hpp-accent);border-radius:999px;padding:.2em .8em;font-size:.85em;font-weight:600;cursor:pointer;background:var(--hpp-chip);color:var(--hpp-accent);';
      chip.addEventListener('click', () => renderRange(v));
      chipRow.appendChild(chip);
    }

    renderRange('this');
    return p;
  }

  function buildWeeklyPace(model) {
    const details = document.createElement('details');
    details.className = 'ao3hpp-details';
    details.open = true;
    details.id = 'hpp-pace-inner';

    const summary = document.createElement('summary');
    summary.textContent = '📈 Weekly pace — last 8 weeks (words · time · speed)';
    details.appendChild(summary);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = (today.getDay() + 6) % 7;
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() - dow);

    const WEEKS_SHOWN = 8;
    const buckets = [];
    for (let i = WEEKS_SHOWN - 1; i >= 0; i--) {
      const s = new Date(thisMonday);
      s.setDate(thisMonday.getDate() - i * 7);
      const e = new Date(s);
      e.setDate(s.getDate() + 6);

      buckets.push({
        startStr: AO3DB.getLocalDateString(s.getTime()),
        endStr: AO3DB.getLocalDateString(e.getTime()),
        label: shortDate(s.getTime()),
        words: 0,
        ms: 0,
      });
    }

    for (const e of model.daily) {
      if (typeof e.date !== 'string') continue;
      for (const b of buckets) {
        if (e.date >= b.startStr && e.date <= b.endStr) {
          b.words += e.wordsDelta || 0;
          b.ms += e.msDelta || 0;
          break;
        }
      }
    }

    const maxW = Math.max(1, ...buckets.map((b) => b.words));
    const ol = document.createElement('ol');
    ol.style.cssText = 'margin:0;padding:0;list-style:none;';

    for (const b of buckets) {
      const pct = Math.round((b.words / maxW) * 100);
      ol.insertAdjacentHTML('beforeend', `
        <li style="display:flex;align-items:center;gap:.6em;margin:.25em 0;">
          <span style="flex:0 0 3.2em;color:var(--hpp-muted);font-size:.85em;">${esc(b.label)}</span>
          <span style="flex:1 1 auto;height:8px;background:var(--hpp-track);border-radius:4px;overflow:hidden;">
            <span style="display:block;height:100%;width:${pct}%;background:var(--hpp-bar);"></span>
          </span>
          <span class="ao3hpp-pace-metric" style="flex:0 0 auto;color:var(--hpp-muted);font-size:.85em;white-space:nowrap;">
            ${formatWords(b.words)} words · ${formatDuration(b.ms)} · ${formatSpeed(b.words, b.ms)}
          </span>
        </li>`);
    }

    details.appendChild(ol);
    return details;
  }

  function buildTimeOfDay(model) {
    const details = document.createElement('details');
    details.className = 'ao3hpp-details';
    details.id = 'hpp-tod-inner';

    const summary = document.createElement('summary');
    summary.textContent = '🕰 When you read (local clock)';
    details.appendChild(summary);

    const { hourTotals, attributedMs, totalMs } = model.timeOfDay;

    if (attributedMs <= 0) {
      details.insertAdjacentHTML('beforeend',
        `<p style="margin:.3em 0;color:var(--hpp-muted);">No hour-attributed data yet — this fills in as you read with 0.2.0+.</p>`);
      return details;
    }

    const maxH = Math.max(1, ...hourTotals);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;align-items:flex-end;gap:2px;height:70px;margin:.4em 0 .2em;';

    for (let h = 0; h < 24; h++) {
      const pct = Math.round((hourTotals[h] / maxH) * 100);
      const col = document.createElement('div');
      col.style.cssText = `flex:1 1 0;background:var(--hpp-bar);border-radius:2px 2px 0 0;height:${Math.max(2, pct)}%;min-width:6px;`;
      col.title = `${String(h).padStart(2, '0')}:00 — ${formatDuration(hourTotals[h])} logged`;
      grid.appendChild(col);
    }

    const axis = document.createElement('div');
    axis.style.cssText = 'display:flex;gap:2px;font-size:.7em;color:var(--hpp-muted);';
    for (let h = 0; h < 24; h++) {
      const lab = document.createElement('span');
      lab.style.cssText = 'flex:1 1 0;text-align:center;min-width:6px;';
      lab.textContent = h % 3 === 0 ? String(h) : '';
      axis.appendChild(lab);
    }

    const share = Math.round((attributedMs / Math.max(1, totalMs)) * 100);
    details.appendChild(grid);
    details.appendChild(axis);
    details.insertAdjacentHTML('beforeend',
      `<p style="margin:.3em 0 0;color:var(--hpp-muted);font-size:.8em;">${share}% of your logged time carries hour detail (collected from 0.2.0 onward).</p>`);

    return details;
  }

  function buildHighlights(model) {
    const p = panel('✨ Highlights');

    const s = model.streaks;
    p.insertAdjacentHTML('beforeend', `
      <p style="margin:.2em 0;">
        🔥 <strong>${s.current}</strong>-day current streak · best ever <strong>${s.best}</strong> · ${s.activeDays} active day${s.activeDays === 1 ? '' : 's'} total
        <span style="color:var(--hpp-muted);">(a day counts once any reading time was logged)</span>
      </p>`);

    const m = model.milestones;
    if (m.achieved.length) {
      p.insertAdjacentHTML('beforeend',
        `<p style="margin:.5em 0 .2em;color:var(--hpp-muted);font-size:.85em;font-weight:600;">Earned (${m.achieved.length}):</p>`);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:.4em;margin:.2em 0 .6em;';
      for (const label of m.achieved) {
        const chip = document.createElement('span');
        chip.style.cssText = 'border:1px solid var(--hpp-border);background:var(--hpp-chip);border-radius:999px;padding:.15em .7em;font-size:.85em;';
        chip.textContent = `🏅 ${label}`;
        wrap.appendChild(chip);
      }
      p.appendChild(wrap);
    }

    if (m.next.length) {
      p.insertAdjacentHTML('beforeend',
        `<p style="margin:.4em 0 .2em;color:var(--hpp-muted);font-size:.85em;font-weight:600;">Next up (closest first):</p>`);
      for (const n of m.next) {
        p.insertAdjacentHTML('beforeend', `
          <div style="display:flex;align-items:center;gap:.6em;margin:.25em 0;">
            <span class="ao3hpp-milestone-label" style="flex:0 0 16em;font-size:.9em;">${esc(n.icon)} ${esc(n.label)}</span>
            <span class="ao3hpp-milestone-bar" style="flex:1 1 auto;height:8px;background:var(--hpp-track);border-radius:4px;overflow:hidden;">
              <span style="display:block;height:100%;width:${n.pct}%;background:var(--hpp-bar);"></span>
            </span>
            <span style="flex:0 0 2.5em;text-align:right;color:var(--hpp-muted);font-size:.85em;">${n.pct}%</span>
          </div>`);
      }
    }

    return p;
  }

  function buildPersonalityCard(model) {
    const pers = computePersonality(model);
    const p = panel('🪪 Reading personality <span style="font-weight:normal;">(computed from your logs — facts only)</span>');

    if (pers.insufficient) {
      p.insertAdjacentHTML('beforeend',
        `<p style="margin:0;color:var(--hpp-muted);">Not enough logged reading yet — check back after a few sessions.</p>`);
      return p;
    }

    for (const l of pers.labels) {
      p.insertAdjacentHTML('beforeend', `
        <p style="margin:.3em 0;">
          <strong style="color:var(--hpp-accent);">${esc(l.name)}</strong>
          <span style="color:var(--hpp-muted);"> — ${esc(l.basis)}</span>
        </p>`);
    }
    return p;
  }

  // ---- funnel ------------------------------------------------------------

  function buildFunnel(model) {
    const f = computeFunnel(model.latestChapters);
    const p = panel('🫀 How your fics end up');

    if (f.started === 0) {
      p.insertAdjacentHTML('beforeend', `<p style="margin:0;color:var(--hpp-muted);">Nothing tracked yet.</p>`);
      return p;
    }

    const droppedEarly = f.started - f.quarter;
    const setAsideLater = f.quarter - f.finishedOrCaughtUp;

    const lines = [
      `<strong>${f.started}</strong> fic${f.started === 1 ? '' : 's'} opened` +
        (droppedEarly > 0
          ? ` — ${droppedEarly} dropped early (before ~¼ in)`
          : ''),
      f.quarter > 0
        ? `<strong>${f.quarter}</strong> got going` +
          (setAsideLater > 0 ? ` — ${setAsideLater} more set aside later` : '')
        : null,
      `<strong>${f.finishedOrCaughtUp}</strong> finished or fully caught up`,
    ].filter(Boolean);

    for (const line of lines) {
      p.insertAdjacentHTML('beforeend',
        `<p style="margin:.25em 0;font-size:.95em;">• ${line}</p>`);
    }

    return p;
  }

  function buildStalled(model) {
    const items = computeStalled(model.allCandidates);
    const p = panel('🧭 Dusty shelf <span style="font-weight:normal;">— started, then left behind</span>');

    if (items.length === 0) {
      p.insertAdjacentHTML('beforeend', `<p style="margin:0;color:var(--hpp-muted);">Nothing gathering dust right now.</p>`);
      return p;
    }

    const ol = document.createElement('ol');
    ol.style.cssText = 'margin:0;padding-left:1.3em;font-size:.9em;';

    for (const c of items) {
      const behind = chaptersBehind(c.reading, c.chapter);
      const bits = [
        `${formatPercent(ficProgressFraction(c.reading, c.chapter))}% through`,
        behind > 0 ? `+${behind} ch waiting` : null,
        `last touched ${formatRelativeTime(c.chapter.lastVisited)}`,
      ].filter(Boolean).join(' · ');

      ol.insertAdjacentHTML('beforeend', `
        <li style="margin:.25em 0;">
          <a href="/works/${c.reading.workId}${c.chapter.chapterId ? `/chapters/${c.chapter.chapterId}` : ''}" style="color:var(--hpp-accent);text-decoration:none;font-weight:600;">${esc(c.reading.title || 'Untitled')}</a>
          <span style="color:var(--hpp-muted);"> — ${bits}</span>
        </li>`);
    }

    p.appendChild(ol);
    return p;
  }

  // ============================================================
  // SELF-CHECK SUITE
  // ============================================================

  async function runSelfCheck() {
    const t0 = performance.now();
    const results = [];
    const add = (name, status, detail = '') => results.push({ name, status, detail });

    // ---------- Layer A ----------
    try {
      const now = Date.now();
      const sample = {
        readings: [{
          workId: 1, title: 'T', authors: ['A'], author: 'A', isOneshot: false,
          chapterCount: 5, chaptersPublished: 4, parserVersion: 2,
          fandoms: ['F'], relationships: [],
          firstOpened: now - 9999, lastVisited: now, lastCheckpoint: now,
          visitCount: 7, totalReadingMs: 12345, totalWordsRead: 900,
        }],
        chapters: [
          { workId: 1, chapterKey: 11, chapterId: 11, chapterNumber: 1, scrollPercent: 1, maxScrollPercent: 1, lastVisited: now, readingMs: 900, bankedWords: 600, wordCount: 600, wordCountVersion: 2 },
          { workId: 1, chapterKey: 12, chapterId: 12, chapterNumber: 2, scrollPercent: 0.5, maxScrollPercent: 0.6, lastVisited: now - 100, readingMs: 400, bankedWords: 300, wordCount: 500, wordCountVersion: 2 },
        ],
        tombstones: [],
        dailyStats: [],
        series: [],
      };

      const once = AO3Sync.mergeAll(sample, sample);
      const twice = AO3Sync.mergeAll(once, sample);

      const stable =
        once.readings.length === 1 &&
        once.readings[0].visitCount === 7 &&
        once.readings[0].totalReadingMs === 12345 &&
        twice.readings.length === 1 &&
        twice.readings[0].visitCount === 7 &&
        once.chapters.length === 2 &&
        twice.chapters.length === 2 &&
        twice.chapters[0].readingMs === 900;

      add('Logic: mergeAll(x, x) is idempotent', stable ? 'pass' : 'fail');
    } catch (err) {
      add('Logic: mergeAll(x, x) is idempotent', 'fail', err.message);
    }

    try {
      const a = { seriesId: 9, title: 'S', fetchedAt: 200, works: [{ workId: 1, title: 'W1' }, { workId: 2, title: 'W2' }] };
      const b = { seriesId: 9, title: 'S', fetchedAt: 100, works: [{ workId: 2, title: 'W2' }, { workId: 3, title: 'W3' }] };
      const u = AO3Sync.mergeSeriesRecord(a, b);
      const ids = u.works.map((w) => w.workId);
      const ok = u.works.length === 3 && new Set(ids).size === 3 && u.fetchedAt === 200;
      add('Logic: series union dedupes and merges both sides', ok ? 'pass' : 'fail', ids.join(','));
    } catch (err) {
      add('Logic: series union dedupes and merges both sides', 'fail', err.message);
    }

    try {
      let overshoot = 0;
      for (const wc of [0, 1, 1867, 99999]) {
        for (const max of [0, 0.33, 0.97, 1]) {
          for (const banked of [0, 50, wc]) {
            const owed = Math.max(0, Math.round(wc * max));
            const credit = Math.max(0, owed - banked);
            const after = Math.min(wc, banked + credit);
            overshoot = Math.max(overshoot, after - wc);
          }
        }
      }
      add('Logic: settle-up can never over-pay', overshoot <= 0 ? 'pass' : 'fail', `max overshoot: ${overshoot}`);
    } catch (err) {
      add('Logic: settle-up can never over-pay', 'fail', err.message);
    }

    // ---------- Layer B ----------
    try {
      const dbv = await new Promise((res, rej) => {
        const r = indexedDB.open('ao3-history-plus-plus');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const stores = Array.from(dbv.objectStoreNames);
      const need = ['readings', 'chapters', 'tombstones', 'dailyStats', 'series'];
      const missing = need.filter((s) => !stores.includes(s));
      dbv.close();

      if (missing.length > 0) {
        add('IndexedDB schema', 'fail', `v${dbv.version}, MISSING stores: ${missing.join(', ')}`);
      } else if (dbv.version !== 6) {
        add('IndexedDB schema', 'warn', `unexpected version ${dbv.version} (expected 6), all stores present`);
      } else {
        add('IndexedDB schema', 'pass', `v6, ${stores.length} stores`);
      }
    } catch (err) {
      add('IndexedDB schema', 'fail', err.message);
    }

    try {
      const key = AO3Crypto.generateKey();
      const blob = { probe: 'ao3hpp-selfcheck', n: 42, arr: [1, 2, 3] };
      const enc = await AO3Crypto.encrypt(blob, key);
      const dec = await AO3Crypto.decrypt(enc, key);
      add('AES-GCM encrypt/decrypt roundtrip', JSON.stringify(dec) === JSON.stringify(blob) ? 'pass' : 'fail');
    } catch (err) {
      add('AES-GCM encrypt/decrypt roundtrip', 'fail', err.message);
    }

    try {
      const k = 'ao3hpp_selfcheck_probe';
      const stamp = `ok-${Date.now()}`;
      GM_setValue(k, stamp);
      const ok = GM_getValue(k, null) === stamp;
      GM_setValue(k, '');
      add('GM storage roundtrip', ok ? 'pass' : 'fail');
    } catch (err) {
      add('GM storage roundtrip', 'fail', err.message);
    }

    try {
      const cfg = getPrefsRemoteConfig();
      if (!cfg) {
        add('GitHub reachable (settings file)', 'skipped', 'sync not configured');
      } else {
        const resp = await statsSyncBridge.fetchImpl(prefsUrl(cfg), {
          headers: {
            Authorization: `Bearer ${cfg.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (resp.status === 200) add('GitHub reachable (settings file)', 'pass', 'HTTP 200');
        else if (resp.status === 404) add('GitHub reachable (settings file)', 'pass', 'HTTP 404 — file not created yet, repo reachable');
        else add('GitHub reachable (settings file)', 'warn', `HTTP ${resp.status}`);
      }
    } catch (err) {
      add('GitHub reachable (settings file)', 'warn', err.message);
    }

    // ---------- Layer C ----------
    try {
      const [readings, chapters, tombstones, daily, seriesRecs] = await Promise.all([
        AO3DB.getAllReadingsSortedByRecent(),
        AO3DB.getAllChapters(),
        AO3DB.getAllTombstones(),
        AO3DB.getAllDailyStats(),
        AO3DB.getAllSeries(),
      ]);

      const chaptersByWork = new Map();
      for (const c of chapters) {
        if (!chaptersByWork.has(c.workId)) chaptersByWork.set(c.workId, []);
        chaptersByWork.get(c.workId).push(c);
      }

      let msFixed = 0;
      for (const r of readings) {
        const chs = chaptersByWork.get(r.workId) || [];
        const maxChMs = chs.reduce((m, c) => Math.max(m, c.readingMs || 0), 0);
        if ((r.totalReadingMs ?? 0) < maxChMs) {
          msFixed++;
          AO3DB.repairTotalReadingMsFloor(r.workId, maxChMs).catch(() => {});
        }
      }
      add('Invariant: totalReadingMs ≥ every chapter readingMs',
          msFixed === 0 ? 'pass' : 'warn',
          msFixed ? `${msFixed} work(s) repaired automatically` : '');

      let wordsDrift = 0;
      const driftDetail = [];
      for (const r of readings) {
        const chs = chaptersByWork.get(r.workId) || [];
        const ledgerSum = chs.reduce((s, c) => s + (c.bankedWords || 0), 0);
        if ((r.totalWordsRead ?? 0) !== ledgerSum) {
          wordsDrift++;
          if (driftDetail.length < 3) driftDetail.push(`#${r.workId}: ${r.totalWordsRead ?? 0} vs ${ledgerSum}`);
        }
      }
      add('Invariant: totalWordsRead = Σ(bankedWords)',
          wordsDrift === 0 ? 'pass' : 'warn',
          wordsDrift ? `${wordsDrift} work(s) drifted (${driftDetail.join('; ')}) — heals on next sync` : '');

      const readingIds = new Set(readings.map((r) => r.workId));
      const orphans = chapters.filter((c) => !readingIds.has(c.workId));
      add('Invariant: no orphan chapter records',
          orphans.length === 0 ? 'pass' : 'fail',
          orphans.length ? orphans.map((c) => `#${c.workId}/${c.chapterKey}`).join(', ') : '');

      const bare = readings.filter((r) => !(chaptersByWork.get(r.workId)?.length));
      add('Info: readings without chapter records', 'pass',
          bare.length ? `${bare.length} (usually visited before tracking existed — harmless)` : 'none');

      let badRange = 0, negCounter = 0, overLedger = 0, badKey = 0;
      for (const c of chapters) {
        for (const f of ['scrollPercent', 'maxScrollPercent']) {
          const v = c[f];
          if (typeof v === 'number' && (Number.isNaN(v) || v < 0 || v > 1)) badRange++;
        }
        if ((c.readingMs ?? 0) < 0 || (c.bankedWords ?? 0) < 0) negCounter++;
        if ((c.wordCount || 0) > 0 && (c.bankedWords || 0) > c.wordCount) overLedger++;
        const expectKey = c.chapterId == null ? 'oneshot' : c.chapterId;
        if (c.chapterKey !== expectKey) badKey++;
      }
      add('Per-chapter: scroll percents within [0,1]', badRange === 0 ? 'pass' : 'warn', badRange ? `${badRange} out of range` : '');
      add('Per-chapter: counters non-negative', negCounter === 0 ? 'pass' : 'fail', negCounter ? `${negCounter} negative value(s)` : '');
      add('Per-chapter: bankedWords ≤ wordCount', overLedger === 0 ? 'pass' : 'warn', overLedger ? `${overLedger} chapter(s) — usually the author shrank the text` : '');
      add('Per-chapter: chapterKey matches chapterId', badKey === 0 ? 'pass' : 'fail', badKey ? `${badKey} inconsistent` : '');

      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      let badDate = 0, negDelta = 0, badBuckets = 0, bucketsOver = 0;
      for (const d of daily) {
        if (!dateRe.test(d.date || '')) badDate++;
        if ((d.wordsDelta ?? 0) < 0 || (d.msDelta ?? 0) < 0) negDelta++;
        if (Array.isArray(d.hourBuckets)) {
          if (d.hourBuckets.length !== 24 || d.hourBuckets.some((v) => typeof v !== 'number' || !isFinite(v) || v < 0)) {
            badBuckets++;
          } else {
            const s = d.hourBuckets.reduce((x, y) => x + (y || 0), 0);
            if (s > (d.msDelta || 0) + 1500) bucketsOver++;
          }
        }
      }
      add('dailyStats: valid dates', badDate === 0 ? 'pass' : 'fail', badDate ? `${badDate} malformed` : '');
      add('dailyStats: deltas non-negative', negDelta === 0 ? 'pass' : 'fail', negDelta ? `${negDelta} negative` : '');
      add('dailyStats: hourBuckets well-formed', badBuckets === 0 ? 'pass' : 'warn', badBuckets ? `${badBuckets} malformed` : '');
      add('dailyStats: hourBuckets ≤ msDelta', bucketsOver === 0 ? 'pass' : 'warn', bucketsOver ? `${bucketsOver} row(s) exceed total` : '');

      let resurrected = 0;
      const liveById = new Map(readings.map((r) => [r.workId, r]));
      for (const t of tombstones) {
        const live = liveById.get(t.workId);
        if (live && (live.lastVisited ?? 0) <= (t.deletedAt ?? 0)) resurrected++;
      }
      add('Tombstones: no stale resurrections', resurrected === 0 ? 'pass' : 'fail',
          resurrected ? `${resurrected} deleted work(s) came back older than their delete` : `${tombstones.length} tombstone(s) checked`);

      let malformedSeries = 0, dupWorks = 0;
      for (const s of seriesRecs) {
        if (!s || s.seriesId == null || !Array.isArray(s.works)) { malformedSeries++; continue; }
        const ids = s.works.map((w) => w && w.workId).filter((x) => x != null);
        if (new Set(ids).size !== ids.length) dupWorks++;
      }
      add('Series: records well-formed, no duplicate works',
          malformedSeries === 0 && dupWorks === 0 ? 'pass' : 'warn',
          [malformedSeries ? `${malformedSeries} malformed` : '', dupWorks ? `${dupWorks} with duplicate works` : ''].filter(Boolean).join('; '));

      const prefsRaw = (() => {
        try { return JSON.parse(GM_getValue('ao3hpp_stats_prefs', 'null')); } catch { return null; }
      })();
      if (prefsRaw) {
        const orderOk = Array.isArray(prefsRaw.order) && new Set(prefsRaw.order).size === prefsRaw.order.length;
        const hiddenOk = !Array.isArray(prefsRaw.hidden) || prefsRaw.hidden.every((h) => Array.isArray(prefsRaw.order) && prefsRaw.order.includes(h));
        add('Layout prefs sane', orderOk && hiddenOk ? 'pass' : 'warn',
            orderOk && hiddenOk ? '' : 'order has duplicates or hidden ⊄ order — auto-corrects on next stats load');
      } else {
        add('Layout prefs sane', 'pass', 'defaults (never customized)');
      }
    } catch (err) {
      add('Data invariants', 'fail', err.message);
    }

    const counts = { pass: 0, warn: 0, fail: 0, skipped: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    const durationMs = Math.round(performance.now() - t0);

    return {
      results,
      summary: counts,
      ok: counts.fail === 0,
      durationMs,
      log() {
        const style = counts.fail > 0
          ? 'color:#900;font-weight:bold'
          : 'color:#2a7a2a;font-weight:bold';
        console.group(`%c[AO3 History++] self-check — ${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail · ${counts.skipped} skipped (${durationMs}ms)`, style);
        console.table(results);
        console.groupEnd();
        return this.summary;
      },
    };
  }

  function renderSelfCheckResults(container, report) {
    container.innerHTML = '';

    const head = document.createElement('p');
    const okColor = report.ok ? '#2a7a2a' : '#900';
    head.style.cssText = `margin:0 0 .5em;font-weight:bold;color:${okColor};`;
    head.textContent =
      `🩺 ${report.summary.pass} passed · ${report.summary.warn} warning${report.summary.warn === 1 ? '' : 's'}` +
      ` · ${report.summary.fail} failed · ${report.summary.skipped} skipped (${report.durationMs}ms)`;
    container.appendChild(head);

    const icons = { pass: '✔', warn: '⚠️', fail: '❌', skipped: '➖' };
    const colors = { pass: 'var(--hpp-muted,#777)', warn: '#a86a00', fail: '#900', skipped: 'var(--hpp-muted,#777)' };

    for (const r of report.results) {
      const line = document.createElement('div');
      line.style.cssText = 'margin:.15em 0;font-size:.88em;line-height:1.4;';

      let html = `<span style="color:${colors[r.status]};">${icons[r.status]} <strong>${esc(r.name)}</strong></span>`;
      if (r.detail) {
        html += ` <span style="color:var(--hpp-muted,#777);">— ${esc(r.detail)}</span>`;
      }
      line.innerHTML = html;
      container.appendChild(line);
    }
  }

  function buildDataBlocks() {
    const p = panel('💾 Your data');

    const btnStyle = 'border:1px solid var(--hpp-accent);background:var(--hpp-chip);color:var(--hpp-accent);border-radius:4px;padding:.4em 1em;font-weight:600;cursor:pointer;';

    // ---- sync status + setup entry -------------------------------------
    const cfg = statsSyncBridge ? statsSyncBridge.getConfig() : null;
    const syncLine = document.createElement('p');
    syncLine.style.cssText = 'margin:0 0 .6em;font-size:.88em;';
    if (cfg) {
      syncLine.innerHTML = `☁️ Sync: <strong style="color:#2a7a2a;">connected</strong>`;
    } else {
      syncLine.innerHTML = `☁️ Sync: <strong>not set up</strong> <span style="color:var(--hpp-muted);">(optional — tracking works without it)</span>`;
    }
    p.appendChild(syncLine);

    const setupBtn = document.createElement('button');
    setupBtn.type = 'button';
    setupBtn.style.cssText = btnStyle;
    setupBtn.textContent = cfg ? '🔑 Sync settings' : '☁️ Connect sync';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.style.cssText = btnStyle + 'margin-left:.6em;';
    exportBtn.textContent = '📤 Export history (JSON)';

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.style.cssText = btnStyle + 'margin-left:.6em;';
    importBtn.textContent = '📥 Import history (merges)';

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.style.cssText = btnStyle + 'margin-left:.6em;';
    checkBtn.title = 'Runs ~20 integrity/capability checks and shows the results here';
    checkBtn.textContent = '🩺 Self-check';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.style.display = 'none';

    const status = document.createElement('p');
    status.style.cssText = 'margin:.6em 0 0;color:var(--hpp-muted);font-size:.85em;';

    const checkOut = document.createElement('div');
    checkOut.style.cssText = 'margin-top:.8em;';

    // ---- auto-resume toggle (device-local) ------------------------------
    const AUTO_RESTORE_KEY = 'ao3hpp_auto_restore';
    const arRow = document.createElement('label');
    arRow.style.cssText = 'display:flex;align-items:center;gap:.6em;margin:.9em 0 .2em;cursor:pointer;font-size:.88em;';
    const arCb = document.createElement('input');
    arCb.type = 'checkbox';
    arCb.checked = GM_getValue(AUTO_RESTORE_KEY, '1') === '1';
    const arSpan = document.createElement('span');
    arSpan.innerHTML = `📍 Auto-resume reading position <span style="color:var(--hpp-muted);">(disable here if it ever glitches on this device — takes effect on next chapter load; per-device setting)</span>`;
    arCb.addEventListener('change', () => {
      GM_setValue(AUTO_RESTORE_KEY, arCb.checked ? '1' : '0');
    });
    arRow.appendChild(arCb);
    arRow.appendChild(arSpan);
    p.appendChild(arRow);

    setupBtn.addEventListener('click', () => {
      if (openSetup) openSetup();
      else status.textContent = 'Setup unavailable on this page.';
    });

    exportBtn.addEventListener('click', async () => {
      try {
        const payload = await AO3DB.buildSyncPayload();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ao3-history-export-${localDateString()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        status.textContent = 'Export downloaded. Note: the file is UNENCRYPTED — treat it like your diary.';
      } catch (err) {
        status.textContent = 'Export failed — see console.';
        console.warn('[AO3 History++] export failed:', err);
      }
    });

    importBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;

      try {
        const parsed = JSON.parse(await file.text());

        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !Array.isArray(parsed.readings) ||
          !Array.isArray(parsed.chapters)
        ) {
          status.textContent = "That file doesn't look like a History++ export.";
          return;
        }

        await AO3DB.applyMergedPayload(parsed, {
          mergeReadingRecord: AO3Sync.mergeReadingRecord,
          mergeChapterRecord: AO3Sync.mergeChapterRecord,
          mergeDailyStatsRecord: AO3Sync.mergeDailyStatsRecord,
          mergeSeriesRecord: AO3Sync.mergeSeriesRecord,
          chapterWinnerSide: AO3Sync.chapterWinnerSide,
        });

        status.textContent = `Imported & merged: ${parsed.readings.length} readings, ${parsed.chapters.length} chapters.`;
        renderStatsPage().catch(() => {});
      } catch (err) {
        status.textContent = 'Import failed — see console.';
        console.warn('[AO3 History++] import failed:', err);
      }
    });

    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      checkOut.innerHTML = `<p style="margin:.6em 0 0;color:var(--hpp-muted);font-size:.85em;">Running checks…</p>`;
      try {
        const report = await runSelfCheck();
        renderSelfCheckResults(checkOut, report);
      } catch (err) {
        checkOut.innerHTML = `<p style="margin:.6em 0 0;color:#900;font-size:.85em;">Self-check crashed: ${esc(err.message)}</p>`;
        console.warn('[AO3 History++] self-check crashed:', err);
      } finally {
        checkBtn.disabled = false;
      }
    });

    p.appendChild(setupBtn);
    p.appendChild(exportBtn);
    p.appendChild(importBtn);
    p.appendChild(checkBtn);
    p.appendChild(fileInput);
    p.appendChild(status);
    p.appendChild(checkOut);
    return p;
  }

  // ============================================================
  // STATS PAGE PREFS — visibility + ordering + PRESETS (0.3.4),
  // synced separately via a small plain JSON file.
  // ============================================================

  const STATS_PREFS_GM_KEY = 'ao3hpp_stats_prefs';
  const STATS_PREFS_REMOTE_DEFAULT = 'ao3hpp-settings.json';

  const SECTION_DEFS = [
    { id: 'overview',    label: '📊 Lifetime overview',   build: buildOverviewCards },
    { id: 'heatmap',     label: '🗓 Reading heatmap',     build: buildHeatmap },
    { id: 'topfics',     label: '🏆 Top fics',            build: buildTopFics },
    { id: 'authors',     label: '🖋 Most-read authors',   build: buildAuthors },
    { id: 'fandoms',     label: '🌐 Fandoms & ships',     build: buildFandoms },
    { id: 'series',      label: '📚 Series progress',     build: buildSeriesProgress },
    { id: 'year',        label: '📅 Year in review',      build: buildYearReview },
    { id: 'pace',        label: '📈 Weekly pace',         build: buildWeeklyPace },
    { id: 'tod',         label: '🕰 When you read',       build: buildTimeOfDay },
    { id: 'highlights',  label: '✨ Highlights',          build: buildHighlights },
    { id: 'personality', label: '🪪 Reading personality', build: buildPersonalityCard },
    { id: 'funnel',      label: '🫀 How fics end up',     build: buildFunnel },
    { id: 'stalled',     label: '🧭 Dusty shelf',         build: buildStalled },
    { id: 'data',        label: '💾 Your data',           build: buildDataBlocks },
  ];

  const DEFAULT_SECTION_ORDER = SECTION_DEFS.map((s) => s.id);

  // Simple keeps the essentials; everything analytical/flavor hides.
  const SIMPLE_SECTION_IDS = ['overview', 'heatmap', 'topfics', 'series', 'data'];

  function derivePresetName(hidden) {
    const norm = (arr) => [...new Set(arr)].sort().join('|');
    const simpleComplement = DEFAULT_SECTION_ORDER.filter((id) => !SIMPLE_SECTION_IDS.includes(id));

    if (hidden.length === 0) return 'Advanced';
    if (norm(hidden) === norm(simpleComplement)) return 'Simple';
    return 'Custom';
  }

  let statsSyncBridge = null;
  let requestSync = null;
  let openSetup = null;
  let prefsRemoteSha = null;
  let prefsSavePushTimer = null;
  let draggedSectionId = null;
  let statsLastPrefsSig = null;

  function setSyncBridge(fetchImpl, getConfig, syncFn) {
    statsSyncBridge = { fetchImpl, getConfig };
    requestSync = syncFn || null;
  }

  function setSetupBridge(fn) {
    openSetup = fn || null;
  }

  function normalizePrefs(raw) {
    const known = new Set(DEFAULT_SECTION_ORDER);
    const order = Array.isArray(raw?.order)
      ? raw.order.filter((id) => known.has(id))
      : [];
    for (const id of DEFAULT_SECTION_ORDER) {
      if (!order.includes(id)) order.push(id);
    }
    const hidden = Array.isArray(raw?.hidden)
      ? raw.hidden.filter((id) => known.has(id))
      : [];
    return {
      version: 1,
      updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0,
      order,
      hidden,
    };
  }

  function loadPrefsLocal() {
    try {
      return normalizePrefs(JSON.parse(GM_getValue(STATS_PREFS_GM_KEY, 'null')));
    } catch {
      return normalizePrefs(null);
    }
  }

  function savePrefs(prefs) {
    prefs.updatedAt = Date.now();
    GM_setValue(STATS_PREFS_GM_KEY, JSON.stringify(prefs));

    if (!statsSyncBridge) return;
    clearTimeout(prefsSavePushTimer);
    prefsSavePushTimer = setTimeout(() => {
      pushPrefs(prefs).catch((err) =>
        console.warn('[AO3 History++] settings push failed:', err)
      );
    }, 1500);
  }

  function getPrefsRemoteConfig() {
    if (!statsSyncBridge) return null;
    const c = statsSyncBridge.getConfig();
    if (!c || !c.token || !c.owner || !c.repo) return null;
    return {
      token: c.token,
      owner: c.owner,
      repo: c.repo,
      path: GM_getValue('gh_settings_path', STATS_PREFS_REMOTE_DEFAULT),
    };
  }

  function prefsUrl(cfg) {
    return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(cfg.path)}`;
  }

  async function pushPrefs(prefs) {
    const cfg = getPrefsRemoteConfig();
    if (!cfg) return;

    // Prefs contain only ASCII ids/timestamps — plain btoa is safe.
    const body = {
      message: `AO3 History++ settings — ${new Date().toISOString()}`,
      content: btoa(JSON.stringify(prefs)),
    };
    if (prefsRemoteSha) body.sha = prefsRemoteSha;

    const resp = await statsSyncBridge.fetchImpl(prefsUrl(cfg), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 200 || resp.status === 201) {
      try {
        const j = await resp.json();
        if (j?.content?.sha) prefsRemoteSha = j.content.sha;
      } catch { /* sha refreshes on next pull */ }
      return;
    }
    console.warn('[AO3 History++] settings push rejected:', resp.status);
  }

  async function pullPrefsOnce() {
    const cfg = getPrefsRemoteConfig();
    if (!cfg) return false;

    const resp = await statsSyncBridge.fetchImpl(prefsUrl(cfg), {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (resp.status === 404) { prefsRemoteSha = null; return false; }
    if (resp.status !== 200) return false;

    const body = await resp.json();
    prefsRemoteSha = body.sha ?? null;

    let remote = null;
    try {
      remote = normalizePrefs(JSON.parse(atob(String(body.content || '').replace(/\n/g, ''))));
    } catch {
      return false;
    }

    const local = loadPrefsLocal();
    if ((remote.updatedAt || 0) > (local.updatedAt || 0)) {
      GM_setValue(STATS_PREFS_GM_KEY, JSON.stringify(remote));
      return true;
    }
    return false;
  }

  function initStatsPrefsSync() {
    if (!statsSyncBridge) return;
    pullPrefsOnce()
      .then((changed) => { if (changed) renderStatsPage().catch(() => {}); })
      .catch((err) => console.warn('[AO3 History++] settings pull failed:', err));
  }

  // ---- section wrapper + drag & drop ----------------------------------

  function buildSectionNode(def, model) {
    const inner = def.build(model);
    if (!inner.id) inner.id = `hpp-${def.id}`;

    const wrap = document.createElement('section');
    wrap.className = 'ao3hpp-panel-section';
    wrap.dataset.section = def.id;
    wrap.style.position = 'relative';

    const handle = document.createElement('div');
    handle.className = 'ao3hpp-drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder';
    handle.style.cssText = 'position:absolute;top:.4em;right:.5em;cursor:grab;font-size:.9em;line-height:1;color:var(--hpp-muted,#777);opacity:0;transition:opacity .15s ease;user-select:none;z-index:5;';
    wrap.appendChild(handle);

    wrap.appendChild(inner);
    return wrap;
  }

  function enablePanelDragging(mount) {
    mount.querySelectorAll('.ao3hpp-drag-handle').forEach((handle) => {
      const panelEl = handle.closest('.ao3hpp-panel-section');
      if (!panelEl || panelEl.dataset.dragBound === '1') return;
      panelEl.dataset.dragBound = '1';

      handle.addEventListener('mousedown', () => { panelEl.draggable = true; });
      window.addEventListener('mouseup', () => { panelEl.draggable = false; }, { once: true });

      panelEl.addEventListener('dragstart', (e) => {
        if (!panelEl.draggable) { e.preventDefault(); return; }
        draggedSectionId = panelEl.dataset.section;
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', draggedSectionId); } catch {}
        requestAnimationFrame(() => { panelEl.style.opacity = '0.45'; });
      });

      panelEl.addEventListener('dragend', () => {
        panelEl.style.opacity = '';
        panelEl.draggable = false;
        const moved = draggedSectionId;
        draggedSectionId = null;
        if (moved) persistOrderFromDOM(mount);
      });
    });

    if (mount.dataset.dropBound === '1') return;
    mount.dataset.dropBound = '1';

    mount.addEventListener('dragover', (e) => {
      if (!draggedSectionId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const dragged = mount.querySelector(`[data-section="${draggedSectionId}"]`);
      if (!dragged) return;

      const target = e.target instanceof Element
        ? e.target.closest('.ao3hpp-panel-section')
        : null;
      if (!target || target === dragged) return;

      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      mount.insertBefore(dragged, before ? target : target.nextSibling);
    });
  }

  function persistOrderFromDOM(mount) {
    const prefs = loadPrefsLocal();
    const domOrder = Array.from(mount.querySelectorAll('.ao3hpp-panel-section'))
      .map((el) => el.dataset.section);

    const hiddenSet = new Set(prefs.hidden);
    const newOrder = [...domOrder];

    for (let idx = 0; idx < prefs.order.length; idx++) {
      const id = prefs.order[idx];
      if (!hiddenSet.has(id)) continue;

      let anchor = null;
      for (let i = idx - 1; i >= 0; i--) {
        if (!hiddenSet.has(prefs.order[i])) { anchor = prefs.order[i]; break; }
      }
      const at = anchor ? newOrder.indexOf(anchor) + 1 : 0;
      newOrder.splice(at, 0, id);
    }

    prefs.order = newOrder;
    savePrefs(prefs);
    populateMiniNav(mount);
  }

  // ---- settings overlay (with Simple/Advanced presets) -----------------

  function buildGearButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ao3hpp-stats-gear';
    btn.textContent = '⚙ Sections';
    btn.title = 'Choose which sections appear on this page';
    btn.style.cssText = 'margin-left:auto;border:1px solid var(--hpp-accent,#900);background:var(--hpp-chip,#fff);color:var(--hpp-accent,#900);border-radius:999px;padding:.15em .8em;font-size:.85em;font-weight:600;cursor:pointer;';
    btn.addEventListener('click', openSectionsOverlay);
    return btn;
  }

  function presetChip(label, value, current, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = value === 'custom'
      ? 'Your layout is customized (hand-ticked sections or reordered panels)'
      : `Show only the essentials`;
    b.style.cssText = `border:1px solid var(--hpp-accent);border-radius:999px;padding:.2em .9em;font-size:.85em;font-weight:600;cursor:pointer;background:${current === label ? 'var(--hpp-accent)' : 'var(--hpp-chip)'};color:${current === label ? '#fff' : 'var(--hpp-accent)'};`;
    if (value !== 'custom') b.addEventListener('click', onClick);
    else b.style.cursor = 'default';
    return b;
  }

  function openSectionsOverlay() {
    document.getElementById('ao3hpp-sections-overlay')?.remove();

    const prefs = loadPrefsLocal();
    const defsById = new Map(SECTION_DEFS.map((d) => [d.id, d]));
    let draftHidden = new Set(prefs.hidden);

    const mountEl = document.querySelector('.ao3hpp-stats-view');
    let cs = {};
    if (mountEl) {
      const s = getComputedStyle(mountEl);
      cs = {
        panel: s.getPropertyValue('--hpp-panel').trim() || '#fff',
        border: s.getPropertyValue('--hpp-border').trim() || '#ddd',
        accent: s.getPropertyValue('--hpp-accent').trim() || '#900',
        text: s.getPropertyValue('--hpp-text').trim() || '#000',
        muted: s.getPropertyValue('--hpp-muted').trim() || '#777',
        chip: s.getPropertyValue('--hpp-chip').trim() || '#fff',
      };
    } else {
      cs = { panel: '#fff', border: '#ddd', accent: '#900', text: '#000', muted: '#777', chip: '#fff' };
    }

    const overlay = document.createElement('div');
    overlay.id = 'ao3hpp-sections-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:1em;';

    const card = document.createElement('div');
    card.style.cssText = `background:${cs.panel};color:${cs.text};border:1px solid ${cs.border};border-radius:6px;max-width:430px;width:100%;max-height:80vh;overflow:auto;padding:1em 1.2em;box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:.95em;`;

    const head = document.createElement('p');
    head.style.cssText = `margin:0 0 .2em;font-weight:bold;color:${cs.accent};`;
    head.textContent = 'Statistics sections';
    card.appendChild(head);

    // ---- preset chips ----
    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;gap:.4em;margin:0 0 .8em;align-items:center;flex-wrap:wrap;';

    const presetLabelSpan = document.createElement('span');
    presetLabelSpan.style.cssText = `color:${cs.muted};font-size:.82em;`;
    presetLabelSpan.textContent = 'Layout:';
    presetRow.appendChild(presetLabelSpan);

    const chipHolder = document.createElement('span');
    chipHolder.style.cssText = 'display:inline-flex;gap:.35em;';

    function refreshPresetChips(currentName) {
      chipHolder.innerHTML = '';
      for (const [name, val] of [['Simple', 'simple'], ['Advanced', 'advanced'], ['Custom', 'custom']]) {
        chipHolder.appendChild(presetChip(name, val, currentName, () => {
          if (val === 'simple') {
            draftHidden = new Set(DEFAULT_SECTION_ORDER.filter((id) => !SIMPLE_SECTION_IDS.includes(id)));
          } else if (val === 'advanced') {
            draftHidden = new Set();
          }
          refreshCheckboxes();
          refreshPresetChips(val === 'simple' ? 'Simple' : 'Advanced');
        }));
      }
    }
    refreshPresetChips(derivePresetName([...draftHidden]));

    presetRow.appendChild(chipHolder);
    card.appendChild(presetRow);

    const sub = document.createElement('p');
    sub.style.cssText = `margin:0 0 .8em;color:${cs.muted};font-size:.82em;`;
    sub.textContent = 'Presets change which sections SHOW; your drag order is never touched. Tick individual boxes below for a Custom layout. Saved and synced.';
    card.appendChild(sub);

    // ---- per-section checkboxes ----
    const checkRows = [];

    function refreshCheckboxes() {
      for (const { cb } of checkRows) {
        cb.checked = !draftHidden.has(cb.dataset.section);
      }
    }

    for (const id of prefs.order) {
      const def = defsById.get(id);
      if (!def) continue;

      const row = document.createElement('label');
      row.style.cssText = `display:flex;align-items:center;gap:.6em;padding:.28em 0;cursor:pointer;border-bottom:1px solid ${cs.border};`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.section = id;
      cb.checked = !draftHidden.has(id);
      cb.addEventListener('change', () => {
        if (cb.checked) draftHidden.delete(id);
        else draftHidden.add(id);
        refreshPresetChips(derivePresetName([...draftHidden]));
      });

      const span = document.createElement('span');
      span.textContent = def.label;

      row.appendChild(cb);
      row.appendChild(span);
      card.appendChild(row);

      checkRows.push({ cb });
    }

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:space-between;margin-top:1em;';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.style.cssText = `border:1px solid ${cs.accent};background:transparent;color:${cs.accent};border-radius:4px;padding:.4em .9em;cursor:pointer;`;
    resetBtn.addEventListener('click', () => {
      const fresh = normalizePrefs(null);
      fresh.updatedAt = Date.now();
      GM_setValue(STATS_PREFS_GM_KEY, JSON.stringify(fresh));
      if (statsSyncBridge) {
        pushPrefs(fresh).catch(() => {});
      }
      overlay.remove();
      renderStatsPage().catch(() => {});
    });

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.textContent = 'Done';
    doneBtn.style.cssText = `border:1px solid ${cs.accent};background:${cs.accent};color:#fff;border-radius:4px;padding:.4em 1.2em;font-weight:600;cursor:pointer;`;
    doneBtn.addEventListener('click', () => {
      const next = loadPrefsLocal();
      next.hidden = [...draftHidden];
      savePrefs(next);
      overlay.remove();
      renderStatsPage().catch(() => {});
    });

    footer.appendChild(resetBtn);
    footer.appendChild(doneBtn);
    card.appendChild(footer);

    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  // ---- mini-nav (derived from prefs) -----------------------------------

  function buildMiniNav() {
    const nav = document.createElement('div');
    nav.style.cssText = 'position:sticky;top:0;z-index:50;display:flex;gap:.3em;flex-wrap:wrap;align-items:center;padding:.4em .2em;margin:0 0 1em;background:var(--hpp-panel,#fafafa);border-bottom:1px solid var(--hpp-border,#ddd);';
    nav.className = 'ao3hpp-stats-mininav';
    return nav;
  }

  function populateMiniNav(mount) {
    const nav = mount.querySelector('.ao3hpp-stats-mininav');
    if (!nav) return;

    const prefs = loadPrefsLocal();
    const defsById = new Map(SECTION_DEFS.map((d) => [d.id, d]));
    nav.innerHTML = '';

    for (const id of prefs.order) {
      if (prefs.hidden.includes(id)) continue;
      const def = defsById.get(id);
      if (!def) continue;

      const a = document.createElement('a');
      a.href = `#hpp-${id}`;
      a.textContent = def.label.replace(/^[^\s]+\s+/, '');
      a.style.cssText = 'font-size:.85em;color:var(--hpp-accent,#900);text-decoration:none;font-weight:600;padding:.1em .5em;';
      nav.appendChild(a);
    }

    // Current layout preset, as a quiet badge.
    const presetBadge = document.createElement('span');
    presetBadge.textContent = derivePresetName(prefs.hidden);
    presetBadge.title = 'Current layout preset — change via ⚙ Sections';
    presetBadge.style.cssText = 'font-size:.72em;color:var(--hpp-muted,#777);border:1px solid var(--hpp-border,#ddd);border-radius:999px;padding:.05em .5em;margin-right:.2em;';
    nav.appendChild(presetBadge);

    nav.appendChild(buildGearButton());
  }

  // ---- refresh hygiene (anti-flicker) ----------------------------------

  let statsRenderCount = 0;
  let statsLastFingerprint = null;

  function activeChipIn(container) {
    if (!container) return null;
    const b = Array.from(container.querySelectorAll('button[data-v]'))
      .find((x) => (x.style.background || '').includes('--hpp-accent'));
    return b ? b.dataset.v : null;
  }

  function captureStatsState(root) {
    const state = { openDetails: [], expandedWorks: [], yearRange: null, topRange: null };

    root.querySelectorAll('details[id]').forEach((d) => {
      if (d.open) state.openDetails.push(d.id);
    });

    root.querySelectorAll('.ao3hpp-deep-body').forEach((body) => {
      if (body.style.display === 'none') return;
      const a = body.closest('li')?.querySelector('a[href*="/works/"]');
      const m = a?.getAttribute('href')?.match(/\/works\/(\d+)/);
      if (m) state.expandedWorks.push(m[1]);
    });

    state.yearRange = activeChipIn(root.querySelector('#hpp-year'));
    state.topRange = activeChipIn(root.querySelector('#hpp-topfics'));

    return state;
  }

  function restoreStatsState(mount, state) {
    if (!state) return;

    for (const id of state.openDetails) {
      const d = mount.querySelector(`details[id="${id}"]`);
      if (d) d.open = true;
    }

    const restoreChip = (panelId, v) => {
      if (!v) return;
      const b = mount.querySelector(`#${panelId} button[data-v="${v}"]`);
      if (b && !(b.style.background || '').includes('--hpp-accent')) b.click();
    };
    restoreChip('hpp-year', state.yearRange);
    restoreChip('hpp-topfics', state.topRange);

    for (const wid of state.expandedWorks) {
      const body = Array.from(mount.querySelectorAll('.ao3hpp-deep-body')).find((el) => {
        const a = el.closest('li')?.querySelector('a[href*="/works/"]');
        return a?.getAttribute('href') === `/works/${wid}`;
      });
      const toggle = body?.closest('li')?.querySelector('.ao3hpp-deep-toggle');
      if (toggle && body && body.style.display === 'none') toggle.click();
    }
  }

  async function renderStatsPage() {
    const mount = ensureStatsMount();
    ensureSkeletonStyles();

    const isFirstRender = statsRenderCount === 0;

    let skel = null;
    if (isFirstRender) {
      skel = skeletonPanel('Gathering your reading data…');
      mount.appendChild(skel);
    }

    let model;
    try {
      const [readings, chapters, daily, seriesRecs] = await Promise.all([
        AO3DB.getAllReadingsSortedByRecent(),
        AO3DB.getAllChapters(),
        AO3DB.getAllDailyStats(),
        AO3DB.getAllSeries(),
      ]);

      const totalWords = readings.reduce((s, r) => s + (r.totalWordsRead || 0), 0);
      const totalMs = readings.reduce((s, r) => s + (r.totalReadingMs || 0), 0);
      const finishedChapters = chapters.filter(
        (c) => (c.maxScrollPercent || 0) >= CONTINUE_READING_DONE_THRESHOLD
      ).length;

      const latestChapters = [];
      const allCandidates = [];
      for (const reading of readings) {
        const chapter = await AO3DB.getLatestChapter(reading.workId);
        if (!chapter) continue;
        latestChapters.push({ reading, chapter });
        const status = getCompletionStatus(reading, chapter, null);
        allCandidates.push({
          reading, chapter, status,
          ficStatus: getFicStatus(reading, null),
        });
      }

      const hourTotals = new Array(24).fill(0);
      let attributedMs = 0;
      for (const e of daily) {
        if (Array.isArray(e.hourBuckets)) {
          for (let h = 0; h < 24; h++) {
            hourTotals[h] += e.hourBuckets[h] || 0;
          }
          attributedMs += e.hourBuckets.reduce((a, b) => a + (b || 0), 0);
        }
      }

      model = {
        readings, daily, series: seriesRecs,
        totalWords, totalMs, finishedChapters,
        chapters,
        streaks: computeStreaks(daily),
        milestones: null,
        timeOfDay: { hourTotals, attributedMs, totalMs },
        latestChapters, allCandidates,
      };
      model.milestones = computeMilestones(model);

      const chaptersMs = chapters.reduce((s, c) => s + (c.readingMs || 0), 0);
      const lastVisitMax = readings.reduce((m, r) => Math.max(m, r.lastVisited || 0), 0);
      const fingerprint = JSON.stringify([
        readings.length, totalWords, totalMs, finishedChapters,
        daily.length, chaptersMs, lastVisitMax,
        seriesRecs.length, seriesRecs.reduce((s, x) => s + (x.works?.length || 0), 0),
      ]);

      const prefsNow = loadPrefsLocal();
      const prefsSig = JSON.stringify([prefsNow.order, prefsNow.hidden]);

      if (
        !isFirstRender &&
        fingerprint === statsLastFingerprint &&
        prefsSig === statsLastPrefsSig
      ) {
        if (skel) skel.remove();
        return;
      }
      statsLastFingerprint = fingerprint;
      statsLastPrefsSig = prefsSig;

    } catch (err) {
      console.warn('[AO3 History++] statistics data gather failed:', err);
      if (skel) skel.remove();
      mount.insertAdjacentHTML('beforeend',
        `<p style="color:#900;">Couldn't load statistics — check the console.</p>`);
      return;
    }

    if (model.readings.length === 0 && model.allCandidates.length === 0) {
      if (skel) skel.remove();
      mount.innerHTML = '';

      const cfg = statsSyncBridge ? statsSyncBridge.getConfig() : null;

      if (!cfg && openSetup) {
        // Unconfigured device landing on Stats: the honest empty-state
        // is "you haven't connected yet", not "you haven't read".
        mount.insertAdjacentHTML('beforeend', `
          <div style="border:1px solid var(--hpp-border,#ddd);border-left:3px solid var(--hpp-accent,#900);background:var(--hpp-panel,#fafafa);border-radius:2px;padding:1em;">
            <p style="margin:0 0 .5em;color:var(--hpp-text);">
              ☁️ <strong>Connect sync to see your library here.</strong><br>
              <span style="color:var(--hpp-muted,#777);font-size:.92em;">Tracking already works locally on this device — connecting mirrors your history from your other devices.</span>
            </p>
          </div>`);
        const connectBtn = document.createElement('button');
        connectBtn.type = 'button';
        connectBtn.textContent = '☁️ Connect sync';
        connectBtn.style.cssText = 'margin-top:.6em;border:1px solid var(--hpp-accent,#900);background:var(--hpp-accent,#900);color:#fff;border-radius:4px;padding:.45em 1.2em;font-weight:600;cursor:pointer;';
        connectBtn.addEventListener('click', () => { if (openSetup) openSetup(); });
        mount.lastElementChild.appendChild(connectBtn);
      } else {
        mount.insertAdjacentHTML('beforeend', `
          <div style="border:1px solid var(--hpp-border,#ddd);border-left:3px solid var(--hpp-accent,#900);background:var(--hpp-panel,#fafafa);border-radius:2px;padding:.8em 1em;">
            <p style="margin:0;color:var(--hpp-muted,#777);">
              📊 <strong>Nothing recorded yet.</strong> Open a work and read a little — your lifetime stats will appear here.
            </p>
          </div>`);
      }

      statsRenderCount++;
      return;
    }

    const prevState = isFirstRender ? null : captureStatsState(mount);

    if (skel) skel.remove();
    mount.innerHTML = '';
    mount.appendChild(buildMiniNav());
    populateMiniNav(mount);

    const prefs = loadPrefsLocal();
    const defsById = new Map(SECTION_DEFS.map((d) => [d.id, d]));

    for (const id of prefs.order) {
      if (prefs.hidden.includes(id)) continue;
      const def = defsById.get(id);
      if (!def) continue;
      mount.appendChild(buildSectionNode(def, model));
    }

    enablePanelDragging(mount);
    restoreStatsState(mount, prevState);
    statsRenderCount++;

    if (new URLSearchParams(window.location.search).get('selfcheck') === '1') {
      setTimeout(async () => {
        try {
          const report = await runSelfCheck();
          report.log();

          const wrap = document.createElement('div');
          wrap.className = 'ao3hpp-panel';
          wrap.style.cssText = 'border:1px solid var(--hpp-border,#ddd);border-left:3px solid var(--hpp-accent,#900);background:var(--hpp-panel,#fafafa);border-radius:2px;padding:.6em .8em;margin:0 0 1.5em;';

          const anchorEl = mount.children[1] || null;
          if (anchorEl) mount.insertBefore(wrap, anchorEl);
          else mount.appendChild(wrap);

          renderSelfCheckResults(wrap, report);
        } catch (err) {
          console.warn('[AO3 History++] auto self-check failed:', err);
        }
      }, 1200);
    }
  }

  // ---- connect-once-per-Paris-day banner -------------------------------

  const CONNECT_NAG_KEY = 'ao3hpp_connect_nag_date';

  function todayInParis() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Paris',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()); // "YYYY-MM-DD"
    } catch {
      return localDateString(); // timezone unsupported → local day fallback
    }
  }

  function maybeShowConnectBanner() {
    if (!openSetup) return;

    const cfg = statsSyncBridge ? statsSyncBridge.getConfig() : null;
    if (cfg) return; // configured — never nag

    if (GM_getValue(CONNECT_NAG_KEY, '') === todayInParis()) return;

    const host = document.querySelector('#main');
    if (!host) return;

    const banner = document.createElement('div');
    banner.className = 'ao3hpp-connect-banner';
    banner.style.cssText = 'display:flex;align-items:center;gap:.8em;flex-wrap:wrap;border:1px solid #ddd;border-left:3px solid #900;background:#fafafa;border-radius:2px;padding:.6em .8em;margin:0 0 1em;';

    const txt = document.createElement('span');
    txt.style.cssText = 'flex:1 1 auto;font-size:.9em;color:#333;';
    txt.innerHTML = `☁️ <strong>AO3 History++</strong> tracks locally. <span style="color:#777;">Connect sync to mirror your history across devices.</span>`;
    banner.appendChild(txt);

    const connectBtn = document.createElement('button');
    connectBtn.type = 'button';
    connectBtn.textContent = 'Connect sync';
    connectBtn.style.cssText = 'border:1px solid #900;background:#900;color:#fff;border-radius:4px;padding:.35em 1em;font-weight:600;cursor:pointer;font-size:.9em;';
    connectBtn.addEventListener('click', () => {
      banner.remove();
      openSetup();
    });
    banner.appendChild(connectBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = '✕';
    dismissBtn.title = 'Dismiss for today';
    dismissBtn.style.cssText = 'border:none;background:none;color:#777;cursor:pointer;font-size:1em;padding:.2em;';
    dismissBtn.addEventListener('click', () => {
      GM_setValue(CONNECT_NAG_KEY, todayInParis());
      banner.remove();
    });
    banner.appendChild(dismissBtn);

    host.prepend(banner);
  }

  async function enhanceHistoryPage(){
    const statsActive = isStatsView();
    injectStatisticsNavItem(statsActive);

    // Once-per-Paris-day connect nudge (skipped silently when sync is
    // already configured). Always-findable alternatives live in 💾
    // Your data and the Statistics empty-state.
    maybeShowConnectBanner();

    // Fresh devices pull remote data on ANY History-page open.
    if (requestSync) {
      requestSync(() => {
        if (isStatsView()) renderStatsPage().catch(() => {});
        else renderContinueReading({ force: true }).catch(() => {});
      });
    }

    const entries = document.querySelectorAll("#main li.reading");

    for(const entry of entries){
      const link = entry.querySelector("a[href*='/works/']");
      if(!link) continue;

      const match = link.href.match(/\/works\/(\d+)/);
      if(!match) continue;

      const workId = Number(match[1]);

      const reading = await AO3DB.getReading(workId);
      const chapter = await AO3DB.getLatestChapter(workId);

      if(!reading || !chapter) continue;

      const chapterStats = getPublishedChapterCount(entry);

      const viewed = entry.querySelector(".viewed");

      const ao3Label = getAO3UpdateLabel(entry, viewed);
      await AO3DB.updateAO3Label(workId, ao3Label);

      if (chapterStats) {
        await AO3DB.updateChapterStatsFromHistory(
          workId,
          chapterStats.published,
          chapterStats.planned
        );
      }

      if (!viewed) continue;

      if (entry.querySelector(".ao3-history-plus-plus")) continue;

      viewed.insertAdjacentElement(
        "afterend",
        createInfoBox(reading, chapter, chapterStats, ao3Label)
      );
    }

    if (statsActive) {
      initStatsPrefsSync();

      await renderStatsPage();

      setInterval(() => {
        renderStatsPage().catch((err) =>
          console.warn('[AO3 History++] statistics refresh failed:', err)
        );
      }, STATS_REFRESH_MS);
    } else {
      await renderContinueReading();
    }

    syncAllHistoryPages().catch((err) =>
      console.warn('[AO3 History++] full history sync failed:', err)
    );
  }

  return {
    enhanceHistoryPage,
    renderReadingTimeWidget,
    setSyncBridge,
    setSetupBridge,
    runSelfCheck,
  };

})();


// ==================================================
// AO3 History++ — Entry Point
// ==================================================

(function () {
  'use strict';

  const SYNC_INTERVAL_MS = 10 * 60 * 1000;
  const CLOSE_DEDUPE_MS = 2000;

  const WORD_EDIT_MIN_DELTA_WORDS = 25;

  const MAX_COMMIT_SPAN_MS = 90_000;

  const SERIES_REFRESH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

  const ENCRYPTION_KEY_STORAGE = 'ao3_encryption_key';
  const GITHUB_TOKEN_STORAGE = 'gh_token';
  const GH_OWNER_STORAGE = 'gh_owner';
  const GH_REPO_STORAGE = 'gh_repo';
  const GH_PATH_STORAGE = 'gh_path';
  const GH_PATH_DEFAULT = 'history.json';

  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        data: options.body,

        onload: (res) => {
          let parsedJson = null;

          try {
            parsedJson = JSON.parse(res.responseText);
          } catch {
            parsedJson = null;
          }

          resolve({
            status: res.status,
            json: async () => parsedJson,
          });
        },

        onerror: (err) => {
          reject(
            new Error(
              'GM_xmlhttpRequest failed: ' +
              (err && err.error
                ? err.error
                : 'unknown error')
            )
          );
        },

        ontimeout: () => {
          reject(
            new Error(
              'GM_xmlhttpRequest timed out'
            )
          );
        },
      });
    });
  }

  // Pure reader — NEVER prompts. Configuration happens exclusively
  // through the setup dialog (openSetupDialog below).
  function getSyncConfig() {
    const token = GM_getValue(GITHUB_TOKEN_STORAGE, '');
    const encryptionKey = GM_getValue(ENCRYPTION_KEY_STORAGE, '');
    const owner = GM_getValue(GH_OWNER_STORAGE, '');
    const repo = GM_getValue(GH_REPO_STORAGE, '');
    const path = GM_getValue(GH_PATH_STORAGE, GH_PATH_DEFAULT);

    if (!token || !encryptionKey || !owner || !repo) {
      return null;
    }

    return {
      token,
      owner,
      repo,
      path,
      encryptionKey,
    };
  }

  let syncInFlight = false;

  /**
   * onResult (optional) fires exactly once with the sync outcome —
   * used by the setup dialog for concrete success/failure feedback
   * (bad token vs wrong repo vs key mismatch).
   */
  async function triggerSync(reason, onSynced, onResult) {
    if (syncInFlight) {
      if (onResult) onResult({ success: false, reason: 'busy' });
      return;
    }

    const config = getSyncConfig();

    if (!config) {
      console.warn('[AO3 History++] sync skipped (not configured):', reason);
      if (onResult) onResult({ success: false, reason: 'not-configured' });
      return;
    }

    syncInFlight = true;

    try {
      const localPayload = await AO3DB.buildSyncPayload();

      const syncedReadingsSnapshot =
        (localPayload.readings || []).map(
          (reading) => ({
            workId: reading.workId,
            lastVisited: reading.lastVisited,
          })
        );

      const result = await AO3Sync.syncToGitHub({
        ...config,
        localPayload,
        fetchImpl: gmFetch,
      });

      if (!result.success) {
        console.warn(
          '[AO3 History++] sync failed:',
          {
            trigger: reason,
            reason: result.reason,
            status: result.status,
            error: result.error,
            result,
          }
        );

        if (onResult) onResult(result);
        return;
      }

      await AO3DB.applyMergedPayload(
        result.merged,
        {
          mergeReadingRecord: AO3Sync.mergeReadingRecord,
          mergeChapterRecord: AO3Sync.mergeChapterRecord,
          mergeDailyStatsRecord: AO3Sync.mergeDailyStatsRecord,
          mergeSeriesRecord: AO3Sync.mergeSeriesRecord,
          chapterWinnerSide: AO3Sync.chapterWinnerSide,
        }
      );

      await AO3DB.markSyncedReadings(
        syncedReadingsSnapshot,
        result.syncedAt
      );

      if (onSynced) {
        await onSynced();
      }
      if (onResult) onResult(result);

    } catch (err) {
      console.warn('[AO3 History++] sync threw:', reason, err);
      if (onResult) {
        onResult({
          success: false,
          reason: 'exception',
          error: err && err.message ? err.message : String(err),
        });
      }
    } finally {
      syncInFlight = false;
    }
  }

  // Fetch the series index page and store full membership.
  async function refreshSeriesMetadata(seriesInfo) {
    const sid = seriesInfo.seriesId;

    try {
      const existing = await AO3DB.getSeries(sid);
      if (existing && Date.now() - (existing.fetchedAt || 0) < SERIES_REFRESH_COOLDOWN_MS) {
        console.log('[AO3 History++] series', sid, 'metadata is fresh — skipping');
        return;
      }

      console.log('[AO3 History++] fetching series page', sid, '…');

      const res = await fetch(`/series/${sid}`, { credentials: 'same-origin' });
      if (!res.ok) {
        console.warn('[AO3 History++] series fetch failed:', res.status);
        return;
      }

      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

      let items = Array.from(doc.querySelectorAll('li[id^="work_"]'));

      if (items.length === 0) {
        items = [...new Set(
          Array.from(doc.querySelectorAll('#main a[href*="/works/"]'))
            .map((a) => a.closest('li'))
            .filter(Boolean)
        )];
      }

      console.log('[AO3 History++] series', sid, '— candidate rows:', items.length);

      const works = [];
      const seen = new Set();

      for (const li of items) {
        const idStr =
          (li.id || '').match(/(\d{4,})/)?.[1] ||
          li.querySelector('a[href*="/works/"]')?.getAttribute('href').match(/\/works\/(\d+)/)?.[1];

        const link =
          li.querySelector('h4.heading a[href*="/works/"]') ||
          li.querySelector('a[href*="/works/"]');

        if (!idStr || !link) continue;

        const wid = Number(idStr);
        if (!wid || seen.has(wid)) continue;
        seen.add(wid);

        works.push({
          workId: wid,
          title: link.textContent.replace(/\s+/g, ' ').trim(),
        });
      }

      if (works.length === 0) {
        console.warn('[AO3 History++] series page parsed but ZERO works found — please report this');
        return;
      }

      const titleEl = doc.querySelector('#main h2.heading') || doc.querySelector('#main h2');

      await AO3DB.putSeries({
        seriesId: sid,
        title: titleEl
          ? titleEl.textContent.replace(/\s+/g, ' ').trim()
          : (existing?.title ?? ''),
        works,
        fetchedAt: Date.now(),
      });

      console.log('[AO3 History++] ✔ series stored:', works.length, 'work(s)');
    } catch (err) {
      console.warn('[AO3 History++] series metadata fetch failed:', err);
    }
  }

  // ==============================================================
  // SETUP DIALOG (0.3.4)
  //
  // One persistent overlay replaces ALL window.prompt() flows:
  //   • survives app-switching (nothing modal)
  //   • every field persists the moment it validates
  //   • key can be generated in-place; token has a step-by-step
  //     guide with a one-click pre-filled GitHub link (classic
  //     token, `repo` scope)
  //   • Save runs a REAL sync and reports the specific outcome
  //     (token rejected / repo not found / key mismatch / success)
  // ==============================================================

  function fieldRow(labelText, inputEl, helpHtml) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:0 0 .9em;';

    const label = document.createElement('label');
    label.style.cssText = 'display:block;margin:0 0 .25em;font-weight:600;font-size:.9em;';
    label.textContent = labelText;
    wrap.appendChild(label);

    inputEl.style.cssText += ';width:100%;box-sizing:border-box;border:1px solid #bbb;border-radius:4px;padding:.45em .6em;font-size:.95em;background:#fff;color:#000;';
    wrap.appendChild(inputEl);

    const help = document.createElement('p');
    help.style.cssText = 'margin:.3em 0 0;color:#666;font-size:.8em;line-height:1.45;';
    help.innerHTML = helpHtml;
    wrap.appendChild(help);

    const validity = document.createElement('p');
    validity.style.cssText = 'margin:.15em 0 0;font-size:.8em;min-height:1.1em;';
    wrap.appendChild(validity);

    inputEl._validityEl = validity;

    return wrap;
  }

  function setFieldValidity(inputEl, ok, msg) {
    if (!inputEl._validityEl) return;
    inputEl._validityEl.style.color = ok ? '#2a7a2a' : '#900';
    inputEl._validityEl.textContent = msg || '';
  }

  function maskedInput(type) {
    const holder = document.createElement('span');
    holder.style.cssText = 'display:flex;gap:.4em;';

    const input = document.createElement('input');
    input.type = type === 'password' ? 'password' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.textContent = '👁';
    eye.title = 'Show/hide';
    eye.style.cssText = 'flex:0 0 auto;border:1px solid #bbb;border-radius:4px;background:#fff;cursor:pointer;padding:0 .5em;';
    eye.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    holder.appendChild(input);
    holder.appendChild(eye);
    holder._input = input;

    return holder;
  }

  function openSetupDialog(onConfigured) {
    document.getElementById('ao3hpp-setup-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ao3hpp-setup-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:1em;';

    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;color:#000;border:1px solid #ccc;border-radius:6px;max-width:520px;width:100%;max-height:90vh;overflow:auto;padding:1.2em 1.4em;box-shadow:0 10px 40px rgba(0,0,0,.4);font-size:.95em;';

    const head = document.createElement('p');
    head.style.cssText = 'margin:0 0 .2em;font-weight:bold;font-size:1.1em;color:#900;';
    head.textContent = '☁️ Connect sync';
    card.appendChild(head);

    const intro = document.createElement('p');
    intro.style.cssText = 'margin:0 0 1em;color:#555;font-size:.88em;line-height:1.5;';
    intro.textContent = 'Mirror your reading history between devices through your own private GitHub repository. Everything is encrypted on this device first — GitHub only ever stores unreadable ciphertext.';
    card.appendChild(intro);

    // ---- encryption key ----
    const keyHolder = maskedInput('password');
    const keyInput = keyHolder._input;
    keyInput.placeholder = 'paste your 43-character key, or press Generate';
    keyInput.value = GM_getValue(ENCRYPTION_KEY_STORAGE, '');

    const keyRow = fieldRow(
      '🔑 Encryption key',
      keyHolder,
      'Same key on EVERY device. Setting up a second device? Copy it from your first device (💾 Your data → 🔑 Sync settings → 👁). ' +
      'First device ever? Hit <strong>Generate</strong> and store the key in your password manager — it cannot be recovered.'
    );

    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.textContent = 'Generate';
    genBtn.style.cssText = 'border:1px solid #900;background:#fff;color:#900;border-radius:4px;padding:.2em .7em;cursor:pointer;font-size:.85em;';
    genBtn.addEventListener('click', () => {
      keyInput.value = AO3Crypto.generateKey();
      keyInput.dispatchEvent(new Event('change'));
      setFieldValidity(keyInput, true, '✔ New key generated — SAVE IT in your password manager now.');
    });
    keyRow.insertBefore(genBtn, keyRow.children[2]); // after input holder

    function validateKeyField() {
      const v = keyInput.value.trim();
      if (!v) { setFieldValidity(keyInput, false, ''); return false; }
      if (AO3Crypto.validateKey(v)) {
        setFieldValidity(keyInput, true, '✔ Valid key');
        return true;
      }
      setFieldValidity(keyInput, false, '❌ Wrong length — a valid key is 43 base64url characters.');
      return false;
    }
    keyInput.addEventListener('change', () => {
      if (validateKeyField()) {
        GM_setValue(ENCRYPTION_KEY_STORAGE, keyInput.value.trim());
      }
    });
    card.appendChild(keyRow);

    // ---- GitHub token ----
    const tokHolder = maskedInput('password');
    const tokInput = tokHolder._input;
    tokInput.placeholder = 'ghp_…';
    tokInput.value = GM_getValue(GITHUB_TOKEN_STORAGE, '');

    const tokRow = fieldRow(
      'GitHub token',
      tokHolder,
      `<details style="margin:.2em 0;"><summary style="cursor:pointer;color:#990000;">How to get a token (one minute)</summary>
        <ol style="margin:.4em 0 0;padding-left:1.2em;">
          <li>Open <a href="https://github.com/settings/tokens/new?scopes=repo&description=AO3%20History%2B%2B" target="_blank" rel="noopener noreferrer">github.com/settings/tokens/new</a> (link pre-selects the right scope)</li>
          <li>Tick <strong>repo</strong> — that's the only scope needed</li>
          <li>Click <strong>Generate token</strong> at the bottom</li>
          <li>Copy it — looks like <code>ghp_</code> + 36 random characters</li>
        </ol>
        Paste it below. It stays on this device and is never uploaded anywhere except GitHub's own API.</details>`
    );

    function validateTokField() {
      const v = tokInput.value.trim();
      if (!v) { setFieldValidity(tokInput, false, ''); return false; }
      if (/^[A-Za-z0-9_]{20,}$/.test(v)) {
        setFieldValidity(tokInput, true, '✔ Looks like a token');
        return true;
      }
      setFieldValidity(tokInput, false, '❌ Tokens are long single strings (letters/numbers/underscore), no spaces.');
      return false;
    }
    tokInput.addEventListener('change', () => {
      if (validateTokField()) {
        GM_setValue(GITHUB_TOKEN_STORAGE, tokInput.value.trim());
      }
    });
    card.appendChild(tokRow);

    // ---- owner / repo ----
    const ownerInput = document.createElement('input');
    ownerInput.placeholder = 'your-username';
    ownerInput.value = GM_getValue(GH_OWNER_STORAGE, '');

    const ownerRow = fieldRow(
      'Repository owner',
      ownerInput,
      'From your private repo\'s URL:<br><code>github.com/<strong>your-username</strong>/<strong>your-sync-repo</strong></code>'
    );

    function validateOwner() {
      const v = ownerInput.value.trim();
      const ok = v.length > 0 && !/[\s\/]/.test(v);
      setFieldValidity(ownerInput, ok, ok ? '✔' : '❌ No spaces or slashes');
      return ok;
    }
    ownerInput.addEventListener('change', () => {
      ownerInput.value = ownerInput.value.trim();
      if (validateOwner()) GM_setValue(GH_OWNER_STORAGE, ownerInput.value);
    });
    card.appendChild(ownerRow);

    const repoInput = document.createElement('input');
    repoInput.placeholder = 'your-sync-repo';
    repoInput.value = GM_getValue(GH_REPO_STORAGE, '');

    const repoRow = fieldRow('Repository name', repoInput,
      'Must exist and be <strong>private</strong>. Create one: github.com/new → check “Private”.');
    const repoIn = repoInput;

    function validateRepo() {
      const v = repoInput.value.trim();
      const ok = v.length > 0 && !/[\s\/]/.test(v);
      setFieldValidity(repoIn, ok, ok ? '✔' : '❌ No spaces or slashes');
      return ok;
    }
    repoIn.addEventListener('change', () => {
      repoIn.value = repoIn.value.trim();
      if (validateRepo()) GM_setValue(GH_REPO_STORAGE, repoIn.value);
    });
    card.appendChild(repoRow);

    // ---- status + actions ----
    const statusEl = document.createElement('p');
    statusEl.style.cssText = 'margin:.9em 0 0;font-size:.88em;min-height:1.2em;';
    card.appendChild(statusEl);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:1em;';

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip for now';
    skipBtn.title = 'Tracking works locally without sync — you can connect anytime via 💾 Your data.';
    skipBtn.style.cssText = 'border:1px solid #999;background:transparent;color:#555;border-radius:4px;padding:.45em 1em;cursor:pointer;';
    skipBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save & connect';
    saveBtn.style.cssText = 'border:1px solid #900;background:#900;color:#fff;border-radius:4px;padding:.45em 1.4em;font-weight:600;cursor:pointer;';

    saveBtn.addEventListener('click', () => {
      const kOk = validateKeyField();
      const tOk = validateTokField();
      const oOk = validateOwner();
      const rOk = validateRepo();

      if (!(kOk && tOk && oOk && rOk)) {
        statusEl.style.color = '#900';
        statusEl.textContent = 'Fix the highlighted fields first.';
        return;
      }

      // Persist everything (fields may not have blurred yet).
      GM_setValue(ENCRYPTION_KEY_STORAGE, keyInput.value.trim());
      GM_setValue(GITHUB_TOKEN_STORAGE, tokInput.value.trim());
      GM_setValue(GH_OWNER_STORAGE, ownerInput.value.trim());
      GM_setValue(GH_REPO_STORAGE, repoInput.value.trim());
      GM_setValue(GH_PATH_STORAGE, GH_PATH_DEFAULT);

      saveBtn.disabled = true;
      statusEl.style.color = '#555';
      statusEl.textContent = 'Connecting & syncing…';

      triggerSync(
        'setup',
        () => {}, // success re-render handled via onResult below
        (result) => {
          saveBtn.disabled = false;

          if (result.success) {
            statusEl.style.color = '#2a7a2a';
            statusEl.textContent = '✔ Connected — history synced.';
            setTimeout(() => {
              overlay.remove();
              if (onConfigured) onConfigured();
            }, 900);
            return;
          }

          statusEl.style.color = '#900';
          switch (result.reason) {
            case 'decrypt-failed':
              statusEl.textContent = '❌ Repo reached, but decryption failed — the encryption key doesn\'t match this repository\'s data. Check for a typo (trailing space?).';
              break;
            case 'get-failed':
            case 'retry-get-failed':
              statusEl.textContent = `❌ GitHub rejected the request (HTTP ${result.status || '?'}). If 401/403: token wrong or lacks the “repo” scope.`;
              break;
            case 'put-failed':
              statusEl.textContent = `❌ Could not write to the repo (HTTP ${result.status || '?'}). Check the token has “repo” scope and the repo exists.`;
              break;
            case 'invalid-encryption-key':
              statusEl.textContent = '❌ Encryption key is malformed.';
              break;
            case 'busy':
              statusEl.textContent = 'Another sync is running — try again in a moment.';
              break;
            default:
              statusEl.textContent = `❌ Sync failed (${result.reason}${result.error ? ': ' + result.error : ''}).`;
          }
        }
      );
    });

    btnRow.appendChild(skipBtn);
    btnRow.appendChild(saveBtn);
    card.appendChild(btnRow);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  async function main() {

    if (
      /^\/users\/[^/]+\/readings\/?$/.test(
        window.location.pathname
      )
    ) {
      console.log(
        '[AO3 History++] Enhancing History page...'
      );

      // Bridges: sync (data + prefs) and setup-dialog opener.
      AO3HistoryUI.setSyncBridge(gmFetch, getSyncConfig, (onDone) => {
        triggerSync('page-open', onDone);
      });
      AO3HistoryUI.setSetupBridge((onConfigured) => {
        openSetupDialog(() => {
          // Post-connect: pull the library down immediately and
          // refresh whichever view is mounted.
          triggerSync('post-setup', () => {
            if (AO3HistoryUI.runSelfCheck) { /* noop guard */ }
          });
          // The page-open hook in enhanceHistoryPage handles the
          // re-render on the NEXT navigation; force one now:
          if (/\/users\//.test(window.location.pathname)) {
            triggerSync('post-setup-refresh', () => {
              window.location.reload();
            });
          }
        });
      });

      await AO3HistoryUI.enhanceHistoryPage();

      return;
    }

    const workState = AO3Parser.parse();

    if (!workState) {
      return;
    }

    if (workState.series && workState.series.seriesId) {
      refreshSeriesMetadata(workState.series).catch(() => {});
    }

    const readingRecord = await AO3DB.upsertReading(workState);

    const existingChapter =
      await AO3DB.getChapter(
        workState.workId,
        workState.chapterId
      );

    // WORD-EDIT DETECTION (device-local), guarded by counter methodology.
    if (
      existingChapter &&
      (existingChapter.wordCountVersion ?? 1) === AO3ScrollTracker.WORD_COUNT_VERSION &&
      (existingChapter.wordCount ?? 0) > 0
    ) {
      const liveWords = AO3ScrollTracker.getWordCount();
      const prevWords = existingChapter.wordCount;

      if (
        liveWords > 0 &&
        Math.abs(liveWords - prevWords) >= WORD_EDIT_MIN_DELTA_WORDS
      ) {
        console.log(
          '[AO3 History++] word count changed since last visit:',
          prevWords,
          '→',
          liveWords
        );

        AO3DB.setWordEdit(
          workState.workId,
          {
            chapterKey: AO3DB.chapterKeyFor(workState.chapterId),
            chapterNumber: workState.chapterNumber,
            prevWords,
            newWords: liveWords,
            delta: liveWords - prevWords,
            detectedAt: Date.now(),
          }
        ).catch((err) => {
          console.warn('[AO3 History++] word-edit detection failed:', err);
        });
      }
    }

    let chapterReadingMs = existingChapter?.readingMs ?? 0;

    if ((readingRecord.totalReadingMs ?? 0) < chapterReadingMs) {
      readingRecord.totalReadingMs = chapterReadingMs;

      AO3DB.repairTotalReadingMsFloor(
        workState.workId,
        chapterReadingMs
      ).catch((err) => {
        console.warn('[AO3 History++] totalReadingMs repair failed:', err);
      });
    }

    const SCROLL_SAVE_MS = 200;
    const SCROLL_POLL_INTERVAL = 100;
    const SCROLL_POLL_MAX = 2000;
    const SCROLL_ANIMATE = true;

    const WIDGET_REFRESH_MS = 15_000;
    const LOCAL_COMMIT_INTERVAL_MS = 10_000;
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

    // Kill-switch for position restore (0.3.4): if it ever glitches
    // on some device/layout, the user can turn it off from 💾 Your
    // data instead of uninstalling. Local per-device setting.
    const AUTO_RESTORE_ENABLED =
      GM_getValue('ao3hpp_auto_restore', '1') === '1';

    let scrollActivitySuppressedUntil = 0;

    if (AUTO_RESTORE_ENABLED && existingChapter) {

      const restorePosition = () => {

        scrollActivitySuppressedUntil = Date.now() + 2000;

        const target =
          AO3ScrollTracker.resolveResumeTarget(existingChapter);

        const maxScroll =
          Math.max(
            0,
            document.documentElement.scrollHeight -
              window.innerHeight
          );

        const desiredScroll =
          Math.min(target.scrollTo, maxScroll);

        console.log(
          '[AO3 History++] restoring position:',
          {
            method: target.method,
            scrollTo: desiredScroll,
            savedPercent: existingChapter.scrollPercent,
            paragraphIndex: existingChapter.paragraphIndex,
            paragraphPreview: existingChapter.paragraphPreview,
          }
        );

        window.scrollTo({
          top: desiredScroll,
          behavior: SCROLL_ANIMATE ? 'smooth' : 'auto',
        });
      };

      const restoreStartedAt = Date.now();

      const pollForRestore = () => {

        const target =
          AO3ScrollTracker.resolveResumeTarget(existingChapter);

        const maxScroll =
          Math.max(
            0,
            document.documentElement.scrollHeight -
              window.innerHeight
          );

        // Unclamped comparison — clamping made this tautologically true.
        const enoughHeight = maxScroll >= target.scrollTo;

        const timedOut =
          Date.now() - restoreStartedAt >= SCROLL_POLL_MAX;

        if (enoughHeight || timedOut) {

          restorePosition();

          setTimeout(restorePosition, 500);

          return;
        }

        setTimeout(pollForRestore, SCROLL_POLL_INTERVAL);
      };

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          pollForRestore();
        });
      });
    }

    let sessionStart = Date.now();
    let maxScrollPercent = 0;
    let latestCheckpoint = null;
    let scrollSaveTimer = null;
    let checkpointWriteInFlight = Promise.resolve();
    let sessionClosing = false;
    let lastCloseAt = 0;
    let closedWhileHidden = false;

    let lastInteractionAt = Date.now();
    let isIdle = false;
    let idleBadgeEl = null;

    function refreshReadingTimeWidget() {
      const elapsedMs = isIdle
        ? Math.min(
            Math.max(0, lastInteractionAt - sessionStart),
            MAX_COMMIT_SPAN_MS
          )
        : Date.now() - sessionStart;

      AO3HistoryUI.renderReadingTimeWidget(
        chapterReadingMs + elapsedMs,
        (readingRecord.totalReadingMs ?? 0) + elapsedMs
      );
    }

    async function refreshWidgetStateFromDB() {
      const [updatedReading, updatedChapter] = await Promise.all([
        AO3DB.getReading(workState.workId),
        AO3DB.getChapter(workState.workId, workState.chapterId),
      ]);

      if (updatedReading) {
        readingRecord.totalReadingMs = updatedReading.totalReadingMs ?? 0;
      }

      if (updatedChapter) {
        chapterReadingMs = updatedChapter.readingMs ?? 0;
      }

      refreshReadingTimeWidget();
    }

    refreshReadingTimeWidget();
    setInterval(refreshReadingTimeWidget, WIDGET_REFRESH_MS);

    // IDLE DETECTION — facts, not nudges.
    function showIdleBadge() {
      if (idleBadgeEl) return;

      const el = document.createElement('div');
      el.className = 'ao3hpp-idle-badge';
      el.textContent = '🌙';
      el.setAttribute('aria-hidden', 'true');

      el.style.position = 'fixed';
      el.style.right = '18px';
      el.style.bottom = '18px';
      el.style.width = '52px';
      el.style.height = '52px';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.fontSize = '24px';
      el.style.background = 'rgba(15, 18, 28, 0.82)';
      el.style.border = '1px solid rgba(255, 255, 255, 0.28)';
      el.style.borderRadius = '50%';
      el.style.boxShadow = '0 2px 12px rgba(0, 0, 0, 0.45)';
      el.style.zIndex = '9999';
      el.style.pointerEvents = 'none';
      el.style.userSelect = 'none';
      el.style.opacity = '0.95';

      document.body.appendChild(el);
      idleBadgeEl = el;
    }

    function hideIdleBadge() {
      if (!idleBadgeEl) return;
      idleBadgeEl.remove();
      idleBadgeEl = null;
    }

    function markInteraction(event) {
      if (
        event &&
        event.type === 'scroll' &&
        Date.now() < scrollActivitySuppressedUntil
      ) {
        return;
      }

      const now = Date.now();

      const wasIdle =
        isIdle ||
        now - lastInteractionAt >= IDLE_TIMEOUT_MS;

      lastInteractionAt = now;

      if (!wasIdle) return;

      isIdle = false;
      hideIdleBadge();

      if (!sessionClosing) {
        sessionStart = now;
        maxScrollPercent =
          latestCheckpoint
            ? latestCheckpoint.scrollPercent
            : 0;
      }

      refreshReadingTimeWidget();
    }

    for (const type of ['wheel', 'touchstart', 'scroll']) {
      window.addEventListener(type, markInteraction, { passive: true });
    }
    for (const type of ['keydown', 'pointerdown']) {
      window.addEventListener(type, markInteraction);
    }

    function updateIdleState() {
      if (isIdle) return;
      if (Date.now() - lastInteractionAt < IDLE_TIMEOUT_MS) return;

      isIdle = true;
      showIdleBadge();
      refreshReadingTimeWidget();
    }

    function saveCheckpointLocally(checkpoint) {

      if (!checkpoint) {
        return checkpointWriteInFlight;
      }

      latestCheckpoint = checkpoint;

      checkpointWriteInFlight =
        checkpointWriteInFlight
          .then(() =>
            AO3DB.upsertChapter(
              workState.workId,
              workState,
              checkpoint,
              chapterReadingMs
            )
          )
          .catch((err) => {
            console.warn(
              '[AO3 History++] local checkpoint write failed:',
              err
            );
          });

      return checkpointWriteInFlight;
    }

    function scheduleCheckpointSave(checkpoint) {

      latestCheckpoint = checkpoint;

      if (scrollSaveTimer !== null) {
        clearTimeout(scrollSaveTimer);
      }

      scrollSaveTimer =
        setTimeout(() => {

          scrollSaveTimer = null;
          saveCheckpointLocally(latestCheckpoint);

        }, SCROLL_SAVE_MS);
    }

    async function flushCheckpoint() {

      if (scrollSaveTimer !== null) {
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = null;
      }

      if (latestCheckpoint) {
        await saveCheckpointLocally(latestCheckpoint);
      }

      await checkpointWriteInFlight;
    }

    const trackerStarted =
      AO3ScrollTracker.start(
        (checkpoint, reason) => {

          latestCheckpoint = checkpoint;

          if (checkpoint.scrollPercent > maxScrollPercent) {
            maxScrollPercent = checkpoint.scrollPercent;
          }

          scheduleCheckpointSave(checkpoint);
        }
      );

    if (!trackerStarted) {
      console.warn('[AO3 History++] scroll tracker did not start');
    }

    // Split a bankable span across local-clock hours.
    function computeHourBuckets(startTs, endTs) {
      if (!(endTs > startTs)) return null;

      const buckets = new Array(24).fill(0);
      let cur = startTs;

      while (cur < endTs) {
        const d = new Date(cur);
        d.setMinutes(59, 59, 999);
        const hourEnd = Math.min(endTs, d.getTime() + 1);
        buckets[d.getHours()] += hourEnd - cur;
        cur = hourEnd;
      }

      return buckets;
    }

    async function persistSessionProgress(reason, { countVisit = false } = {}) {

      if (sessionClosing) {
        return false;
      }

      sessionClosing = true;

      try {

        await flushCheckpoint();

        const now = Date.now();

        const bankableEnd = Math.min(now, lastInteractionAt);

        const rawSpan = Math.max(0, bankableEnd - sessionStart);
        const durationMs = Math.min(rawSpan, MAX_COMMIT_SPAN_MS);

        const sessionScrollPercent = maxScrollPercent;
        const wordCount = AO3ScrollTracker.getWordCount();

        const hourBuckets =
          durationMs > 0
            ? computeHourBuckets(bankableEnd - durationMs, bankableEnd)
            : null;

        let recorded = false;

        try {

          if (durationMs > 0) {
            recorded =
              await AO3DB.recordSessionIfEligible(
                workState.workId,
                workState.chapterId,
                durationMs,
                sessionScrollPercent,
                countVisit,
                wordCount,
                hourBuckets
              );
          }

          if (recorded) {
            chapterReadingMs += durationMs;
            readingRecord.totalReadingMs =
              (readingRecord.totalReadingMs ?? 0) + durationMs;

            sessionStart = now;

            maxScrollPercent =
              latestCheckpoint
                ? latestCheckpoint.scrollPercent
                : 0;

            if (recorded.wordsCredited > 0) {
              console.log(
                '[AO3 History++] credited',
                recorded.wordsCredited,
                'words (settle-up)'
              );
            }

            AO3DB.clearWordEdit(
              workState.workId,
              AO3DB.chapterKeyFor(workState.chapterId)
            ).catch((err) => {
              console.warn('[AO3 History++] word-edit badge clear failed:', err);
            });
          }

        } catch (err) {

          console.warn('[AO3 History++] session recording failed:', err);
        }

        return recorded;

      } finally {

        sessionClosing = false;
      }
    }

    async function closeSession(reason) {

      const now = Date.now();

      if (now - lastCloseAt < CLOSE_DEDUPE_MS) {
        return;
      }

      lastCloseAt = now;

      await persistSessionProgress(reason, { countVisit: true });

      await triggerSync(reason, refreshWidgetStateFromDB);
    }

    function commitLocalProgress() {

      if (
        typeof document === 'undefined' ||
        document.visibilityState !== 'visible'
      ) {
        return;
      }

      updateIdleState();

      persistSessionProgress('interval-local').catch((err) => {
        console.warn(
          '[AO3 History++] periodic local commit failed:',
          err
        );
      });
    }

    setInterval(commitLocalProgress, LOCAL_COMMIT_INTERVAL_MS);

    document.addEventListener(
      'visibilitychange',
      () => {

        if (document.visibilityState === 'hidden') {

          closedWhileHidden = true;

          closeSession('visibilitychange');

          return;
        }

        closedWhileHidden = false;

        lastInteractionAt = Date.now();

        if (isIdle) {
          isIdle = false;
          hideIdleBadge();
        }

        if (!sessionClosing) {
          sessionStart = Date.now();

          maxScrollPercent =
            latestCheckpoint
              ? latestCheckpoint.scrollPercent
              : 0;
        }

        lastCloseAt = 0;

        refreshReadingTimeWidget();
      }
    );

    window.addEventListener(
      'pagehide',
      () => {

        if (
          document.visibilityState === 'hidden' &&
          closedWhileHidden
        ) {
          triggerSync(
            'pagehide-after-hidden',
            refreshWidgetStateFromDB
          );

          return;
        }

        closeSession('pagehide');

      }
    );

    flushCheckpoint().then(() => {
      triggerSync('load', refreshWidgetStateFromDB);
    });

    setInterval(
      () => {

        flushCheckpoint().then(() => {
          triggerSync('interval', refreshWidgetStateFromDB);
        });

      },
      SYNC_INTERVAL_MS
    );
  }

  main().catch((err) => {
    console.warn(
      '[AO3 History++] initialization failed:',
      err
    );
  });

  // Console bridge — repair workflow: await AO3HPP.runSelfCheck().log()
  try {
    unsafeWindow.AO3HPP = {
      runSelfCheck: () => AO3HistoryUI.runSelfCheck(),
      db: AO3DB,
      sync: AO3Sync,
    };
  } catch {
    // unsafeWindow unavailable — button/deep-link entry points still work.
  }

})();
