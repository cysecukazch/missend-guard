/**
 * history-store.js — 宛先履歴と設定の永続化。
 * 全履歴は chrome.storage.local（端末内）に保存する。
 * 加えて設定 syncEnabled=true のとき、圧縮した学習データを chrome.storage.sync に
 * ミラーし、同じ Google アカウントの別 PC と自動で同期する（PSG_SyncCodec）。
 * sync を有効にした場合のみデータが Chrome の同期基盤（ユーザー自身のアカウント）に
 * 載る。開発者・第三者への送信は一切ない。
 */
(function (root) {
    'use strict';

    const Codec = root.PSG_SyncCodec;

    const KEY = 'psg_v1';
    const MAX_RECIPIENTS = 3000; // 超えたら古いものから削除
    const MAX_COMBOS = 1000;
    const MAX_THREADS = 500;
    const SYNC_DEBOUNCE_MS = 8000; // 送信の連続をまとめて1回書く（書込回数制限対策）

    const EMPTY = () => ({
        recipients: {},  // email -> {c: 回数, t: 最終送信 epoch ms, n: 表示名}
        domains: {},     // domain -> {c, t}
        combos: {},      // "a.jp|b.jp" -> 最終送信 epoch ms
        pairAcks: {},    // "a@x|b@y" -> 「別人と確認済み」epoch ms
        greetAcks: {},   // "宛名|email" -> 「この宛名でOKと確認済み」epoch ms
        threads: {},     // 件名ハッシュ -> {r: [emails], t}
        stats: { sends: 0, dialogs: 0, autoPass: 0 },
        settings: {},
        // レビューのお願いの状態（この端末のみ。sync には載せない）
        review: { installTs: 0, state: 'none', shownCount: 0, lastShownTs: 0, lastCancelTs: 0 }
    });

    let cache = null;
    let loading = null; // 並行 load() で cache が二重生成されないよう promise を共有する

    function load() {
        if (cache) return Promise.resolve(cache);
        if (loading) return loading;
        loading = new Promise(resolve => {
            try {
                chrome.storage.local.get(KEY, data => {
                    cache = Object.assign(EMPTY(), data && data[KEY]);
                    stampInstall();
                    loading = null;
                    resolve(cache);
                });
            } catch (e) {
                cache = EMPTY();
                loading = null;
                resolve(cache);
            }
        });
        return loading;
    }

    /** 初回ロード時に導入日時を記録する（レビューのお願いの「導入から◯日」判定用） */
    function stampInstall() {
        if (!cache.review) cache.review = { installTs: 0, state: 'none', shownCount: 0, lastShownTs: 0, lastCancelTs: 0 };
        if (!cache.review.installTs) {
            cache.review.installTs = Date.now();
            save();
        }
    }

    // 保存・同期の状態（設定画面で可視化する）
    let status = { localError: '', syncState: 'ok', syncError: '', lastSyncAt: 0 };

    function save() {
        return new Promise(resolve => {
            try {
                chrome.storage.local.set({ [KEY]: cache }, () => {
                    try {
                        status.localError = (chrome.runtime && chrome.runtime.lastError)
                            ? (chrome.runtime.lastError.message || 'error') : '';
                    } catch (e) { /* ignore */ }
                    resolve();
                });
            } catch (e) {
                status.localError = String(e && e.message || e);
                resolve();
            }
        });
    }

    function getStatus() { return Object.assign({}, status, { lastSyncAt: syncInfo.at }); }

    function pruneMap(map, max) {
        const keys = Object.keys(map);
        if (keys.length <= max) return;
        keys.sort((a, b) => (map[a].t || map[a] || 0) - (map[b].t || map[b] || 0));
        for (const k of keys.slice(0, keys.length - max)) delete map[k];
    }

    /** 直近の学習を取り消すための巻き戻し情報（undoLastLearn 用） */
    let lastUndo = null;

    /** 送信確定時に呼ぶ。learn は RiskEngine.analyze の戻り値 */
    async function recordSend(learn, viaDialog) {
        const db = await load();
        const now = Date.now();
        const undo = { recipNew: [], recipInc: [], domNew: [], domInc: [], combo: null,
            pairAcks: [], greetAcks: [], threadKey: null, threadWasNew: false, threadAdded: [], viaDialog };
        if (learn) {
            for (const r of learn.recipients) {
                const existed = !!db.recipients[r.email];
                const cur = db.recipients[r.email] || { c: 0, t: 0, n: '' };
                cur.c += 1;
                cur.t = now;
                if (r.name) cur.n = r.name;
                db.recipients[r.email] = cur;
                (existed ? undo.recipInc : undo.recipNew).push(r.email);
            }
            for (const d of learn.domains) {
                const existed = !!db.domains[d];
                const cur = db.domains[d] || { c: 0, t: 0 };
                cur.c += 1;
                cur.t = now;
                db.domains[d] = cur;
                (existed ? undo.domInc : undo.domNew).push(d);
            }
            if (learn.combo && !(learn.combo in db.combos)) undo.combo = learn.combo;
            if (learn.combo) db.combos[learn.combo] = now;
            for (const k of (learn.pairAcks || [])) { if (!(k in db.pairAcks)) undo.pairAcks.push(k); db.pairAcks[k] = now; }
            for (const k of (learn.greetAcks || [])) { if (!(k in db.greetAcks)) undo.greetAcks.push(k); db.greetAcks[k] = now; }
            if (learn.threadKey) {
                undo.threadKey = learn.threadKey;
                undo.threadWasNew = !db.threads[learn.threadKey];
                const th = db.threads[learn.threadKey] || { r: [], t: 0 };
                const before = new Set(th.r);
                undo.threadAdded = (learn.threadRecipients || []).filter(e => !before.has(e));
                th.r = [...new Set(th.r.concat(learn.threadRecipients || []))];
                th.t = now;
                db.threads[learn.threadKey] = th;
            }
            pruneMap(db.recipients, MAX_RECIPIENTS);
            pruneMap(db.combos, MAX_COMBOS);
            pruneMap(db.pairAcks, MAX_COMBOS);
            pruneMap(db.greetAcks, MAX_COMBOS);
            pruneMap(db.threads, MAX_THREADS);
        }
        db.stats.sends += 1;
        if (viaDialog) db.stats.dialogs += 1; else db.stats.autoPass += 1;
        lastUndo = undo;
        await save();
        scheduleSyncPush();
    }

    /** 直近の recordSend による学習を巻き戻す（Undo Send 後などの毒抜き用） */
    async function undoLastLearn() {
        if (!lastUndo) return false;
        const db = await load();
        const u = lastUndo;
        for (const e of u.recipNew) delete db.recipients[e];
        for (const e of u.recipInc) if (db.recipients[e]) db.recipients[e].c = Math.max(0, db.recipients[e].c - 1);
        for (const d of u.domNew) delete db.domains[d];
        for (const d of u.domInc) if (db.domains[d]) db.domains[d].c = Math.max(0, db.domains[d].c - 1);
        if (u.combo) delete db.combos[u.combo];
        for (const k of u.pairAcks) delete db.pairAcks[k];
        for (const k of u.greetAcks) delete db.greetAcks[k];
        if (u.threadKey && db.threads[u.threadKey]) {
            if (u.threadWasNew) delete db.threads[u.threadKey];
            else db.threads[u.threadKey].r = db.threads[u.threadKey].r.filter(e => !u.threadAdded.includes(e));
        }
        db.stats.sends = Math.max(0, db.stats.sends - 1);
        if (u.viaDialog) db.stats.dialogs = Math.max(0, db.stats.dialogs - 1);
        else db.stats.autoPass = Math.max(0, db.stats.autoPass - 1);
        lastUndo = null;
        await save();
        scheduleSyncPush();
        return true;
    }
    function hasUndo() { return !!lastUndo; }

    /** 特定の宛先を学習から忘れる（次回から「初めての宛先」に戻る）。関連 ack も除去 */
    async function forgetRecipient(email) {
        const db = await load();
        email = String(email || '').toLowerCase();
        if (!db.recipients[email]) return false;
        delete db.recipients[email];
        for (const k of Object.keys(db.pairAcks)) if (k.split('|').includes(email)) delete db.pairAcks[k];
        for (const k of Object.keys(db.greetAcks)) if (k.slice(k.lastIndexOf('|') + 1) === email) delete db.greetAcks[k];
        for (const h of Object.keys(db.threads)) {
            const th = db.threads[h];
            th.r = th.r.filter(e => e !== email);
            if (th.r.length === 0) delete db.threads[h];
        }
        await save();
        scheduleSyncPush();
        return true;
    }

    /* ------------------------------------------------------------------ */
    /* chrome.storage.sync ミラー（端末間同期）                             */
    /* ------------------------------------------------------------------ */

    let syncTimer = 0;
    let lastShardKeys = [];      // 前回書き込んだシャードキー（差分・削除用）
    let syncInfo = { kept: null, dropped: null, bytes: 0, at: 0 };

    function syncAvailable() {
        try { return !!(Codec && chrome.storage && chrome.storage.sync); } catch (e) { return false; }
    }

    /** デバウンスして sync へ書き込む（送信の連続を1回にまとめる） */
    function scheduleSyncPush() {
        if (!syncAvailable()) return;
        if (cache && cache.settings && cache.settings.syncEnabled === false) return;
        if (syncTimer) return;
        // テストハーネスのみ短縮可（本番は 8s のまま）
        const ms = (typeof root.PSG_TEST_SYNC_DEBOUNCE === 'number') ? root.PSG_TEST_SYNC_DEBOUNCE : SYNC_DEBOUNCE_MS;
        syncTimer = setTimeout(() => { syncTimer = 0; syncPush(); }, ms);
    }

    function syncPush() {
        if (!syncAvailable() || !cache) return;
        if (cache.settings && cache.settings.syncEnabled === false) return;
        let shards, meta;
        try { ({ shards, meta } = Codec.encode(cache)); } catch (e) { return; }
        const newKeys = Object.keys(shards);
        // 不要になった旧シャードを削除
        const stale = lastShardKeys.filter(k => !(k in shards));
        try {
            chrome.storage.sync.set(shards, () => {
                const err = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                if (err) { status.syncState = 'error'; status.syncError = err; return; }
                if (stale.length) chrome.storage.sync.remove(stale, () => {});
                lastShardKeys = newKeys;
                status.syncState = 'ok'; status.syncError = '';
                syncInfo = { kept: meta.kept, dropped: meta.dropped, bytes: meta.bytes, at: Date.now() };
            });
        } catch (e) { status.syncState = 'error'; status.syncError = String(e && e.message || e); }
    }

    /** sync から全シャードを読み、cache にマージする。変化があれば local にも保存 */
    function syncPull() {
        return new Promise(resolve => {
            if (!syncAvailable()) return resolve(false);
            try {
                chrome.storage.sync.get(null, async (items) => {
                    if (chrome.runtime && chrome.runtime.lastError) return resolve(false);
                    const picked = {};
                    for (const k of Object.keys(items || {})) {
                        if (k === Codec.META_KEY || k.startsWith(Codec.KEY_PREFIX)) picked[k] = items[k];
                    }
                    if (Object.keys(picked).length) lastShardKeys = Object.keys(picked).filter(k => k !== Codec.META_KEY);
                    const incoming = Codec.decode(picked);
                    if (!incoming) return resolve(false);
                    const db = await load();
                    const changed = Codec.merge(db, incoming);
                    if (changed) {
                        pruneMap(db.recipients, MAX_RECIPIENTS);
                        pruneMap(db.combos, MAX_COMBOS);
                        pruneMap(db.pairAcks, MAX_COMBOS);
                        pruneMap(db.greetAcks, MAX_COMBOS);
                        pruneMap(db.threads, MAX_THREADS);
                        await save();
                    }
                    resolve(changed);
                });
            } catch (e) { resolve(false); }
        });
    }

    function getSyncInfo() { return syncInfo; }

    async function getHistory() {
        const db = await load();
        return db;
    }

    /* --- レビューのお願いの状態（src/review-gate.js が判定に使う） --- */

    /** 表示した瞬間に呼ぶ（無操作で消えても回数は消費される） */
    async function markReviewShown() {
        const db = await load();
        db.review.shownCount = (db.review.shownCount || 0) + 1;
        db.review.lastShownTs = Date.now();
        await save();
    }

    /** ボタンを操作したら呼ぶ（レビュー・要望・今後表示しない、いずれでも以後は出さない） */
    async function markReviewDone() {
        const db = await load();
        db.review.state = 'done';
        await save();
    }

    /** 確認ダイアログをキャンセルしたら呼ぶ（30分間はレビューのお願いを出さない。全タブで共有） */
    async function markReviewCanceled() {
        const db = await load();
        db.review.lastCancelTs = Date.now();
        await save();
    }

    async function getSettings() {
        const db = await load();
        return Object.assign({}, root.PSG_RiskEngine.DEFAULT_SETTINGS, db.settings);
    }

    async function setSettings(patch) {
        const db = await load();
        db.settings = Object.assign({}, db.settings, patch);
        await save();
    }

    async function clearHistory() {
        const db = await load();
        db.recipients = {};
        db.domains = {};
        db.combos = {};
        db.pairAcks = {};
        db.greetAcks = {};
        db.threads = {};
        await save();
        // sync ミラーも消す
        if (syncAvailable() && lastShardKeys.length) {
            try { chrome.storage.sync.remove(lastShardKeys.concat([Codec.META_KEY]), () => {}); } catch (e) {}
            lastShardKeys = [];
        }
    }

    async function setSyncEnabled(on) {
        await setSettings({ syncEnabled: !!on });
        if (on) { await syncPull(); syncPush(); }   // ON にしたら即取り込み＆書き出し
    }

    let syncPullTimer = 0;
    // 設定画面など他コンテキストの変更、および他 PC からの sync 更新を反映
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[KEY]) {
                cache = Object.assign(EMPTY(), changes[KEY].newValue);
            }
            // 他 PC が sync を更新 → デバウンスして取り込み（自分の書込みでも発火するが冪等）
            if (area === 'sync') {
                const relevant = Object.keys(changes).some(k => k === Codec.META_KEY || k.startsWith(Codec.KEY_PREFIX));
                if (relevant && !syncPullTimer) {
                    syncPullTimer = setTimeout(() => { syncPullTimer = 0; syncPull(); }, 1500);
                }
            }
        });
    } catch (e) { /* テスト環境では chrome が無い */ }

    // 起動時: local を読んだ後、sync から取り込んで新 PC を種付けする
    (async () => {
        try {
            const s = await getSettings();
            if (s.syncEnabled !== false) await syncPull();
        } catch (e) { /* ignore */ }
    })();

    root.PSG_Store = {
        load, recordSend, getHistory, getSettings, setSettings, clearHistory,
        setSyncEnabled, getSyncInfo, getStatus, syncPull,
        undoLastLearn, hasUndo, forgetRecipient,
        markReviewShown, markReviewDone, markReviewCanceled, KEY
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
