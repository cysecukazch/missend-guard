/**
 * sync-codec.js — 学習データを chrome.storage.sync の上限内に収める圧縮コーデック。
 *
 * sync の上限: 合計 102,400B / 1項目 8,192B / 512項目。
 * 本コーデックは辞書＋インデックス圧縮で、当拡張の最大容量
 * （宛先3000・combo/ack各1000・スレッド500）を丸ごと収める。
 * 万一超える病的ケースのみ、優先度順（宛先＞スレッド＞combo＞ack）に
 * 末尾からトリムし、落とした件数を meta に記録する（＝黙って漏れない）。
 *
 * 圧縮方針:
 *   - ドメインを辞書化（D）。宛先は「localpart ~ domainIdx ~ count」で保持（E）。
 *   - combo/pairAck/greetAck/thread は宛先/ドメインを整数インデックスで参照。
 *   - 表示名は同期しない（容量最大要因かつ既知判定に不要。再送信で再学習される）。
 *   - タイムスタンプも持たず、宛先を新しい順に並べて順序で recency を表現する。
 *
 * DOM・chrome API に依存しない純粋ロジック（Node で単体テスト可能）。
 */
(function (root) {
    'use strict';

    const FORMAT = '1';
    // 実上限は合計 102,400B。シャードキー・メタ JSON の分（~400B）を見込み 99,000B を上限に。
    const TOTAL_BUDGET = 99000;
    const SHARD_MAX = 7800;       // 8,192 未満（UTF-8 バイトで判定）
    const KEY_PREFIX = 'psg_y';   // シャードキー: psg_y0, psg_y1, ...
    const META_KEY = 'psg_ymeta';

    const b36 = (n) => (n >>> 0).toString(36);
    const p36 = (s) => parseInt(s, 36) || 0;

    /** UTF-8 バイト長 */
    function bytes(s) {
        let n = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c < 0x80) n += 1;
            else if (c < 0x800) n += 2;
            else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
            else n += 3;
        }
        return n;
    }

    const domainOf = (email) => { const a = email.lastIndexOf('@'); return a === -1 ? '' : email.slice(a + 1); };
    const localOf = (email) => { const a = email.lastIndexOf('@'); return a === -1 ? email : email.slice(0, a); };

    /** 区切り文字（space, |, ~, \n, ,）を含む値は同期対象から外す（破損防止） */
    const SAFE = (s) => !/[\s|~\n,]/.test(s);

    /**
     * @param db {{recipients,domains,combos,pairAcks,greetAcks,threads,stats}}
     * @returns {{shards:Object, meta:Object}}
     *   shards: { psg_y0: str, ..., psg_ymeta: json }
     *   meta:   { v, n, kept:{recipients,combos,pairAcks,greetAcks,threads}, dropped:{...}, bytes }
     */
    function encode(db) {
        db = db || {};
        const recips = db.recipients || {};
        const combos = db.combos || {};
        const pairAcks = db.pairAcks || {};
        const greetAcks = db.greetAcks || {};
        const threads = db.threads || {};
        const stats = db.stats || { sends: 0, dialogs: 0, autoPass: 0 };

        const dropped = { recipients: 0, combos: 0, pairAcks: 0, greetAcks: 0, threads: 0 };

        // --- 宛先を新しい順に並べる（recency）。不正な宛先は除外＝漏れとして計上 ---
        const emails = [];
        for (const e of Object.keys(recips)) {
            if (e.includes('@') && SAFE(e)) emails.push(e);
            else dropped.recipients++;
        }
        emails.sort((a, b) => (recips[b].t || 0) - (recips[a].t || 0));

        // --- ドメイン辞書 ---
        const domIndex = new Map();  // domain -> idx
        const domList = [];
        const domIdx = (d) => {
            if (domIndex.has(d)) return domIndex.get(d);
            const i = domList.length; domList.push(d); domIndex.set(d, i); return i;
        };

        // --- 予算管理: 宛先を優先し、残りを ack に割り当てる ---
        const emailIndex = new Map(); // email -> idx（採用したものだけ）
        const eItems = [];
        // 宛先には全体の 82% を上限として割当（残りは ack）
        const RECIP_CAP = Math.floor(TOTAL_BUDGET * 0.82);
        let used = bytes(FORMAT) + 40; // ヘッダ・stats 余裕

        for (const email of emails) {
            const lp = localOf(email), dm = domainOf(email);
            if (!SAFE(lp) || !SAFE(dm)) { dropped.recipients++; continue; }
            const isNewDom = !domIndex.has(dm);
            const di = domIdx(dm);
            const item = lp + '~' + b36(di) + '~' + b36((recips[email].c || 1));
            // ドメインは辞書で共有されるため、新規ドメインのときだけそのバイトを加算
            const cost = bytes(item) + 1 + (isNewDom ? bytes(dm) + 1 : 0);
            if (used + cost > RECIP_CAP) {
                if (isNewDom) { domList.pop(); domIndex.delete(dm); } // 使わない辞書登録を取り消す
                dropped.recipients++; continue;
            }
            used += cost;
            emailIndex.set(email, eItems.length);
            eItems.push(item);
        }

        // --- combos（ドメインidxのペア。両ドメインが辞書にある場合のみ） ---
        const kItems = [];
        for (const key of Object.keys(combos)) {
            const ds = key.split('|');
            if (ds.length !== 2 || !domIndex.has(ds[0]) || !domIndex.has(ds[1])) { dropped.combos++; continue; }
            const item = b36(domIndex.get(ds[0])) + '~' + b36(domIndex.get(ds[1]));
            const cost = bytes(item) + 1;
            if (used + cost > TOTAL_BUDGET) { dropped.combos++; continue; }
            used += cost; kItems.push(item);
        }

        // --- pairAcks（両宛先が採用済みの場合のみ） ---
        const pItems = [];
        for (const key of Object.keys(pairAcks)) {
            const es = key.split('|');
            if (es.length !== 2 || !emailIndex.has(es[0]) || !emailIndex.has(es[1])) { dropped.pairAcks++; continue; }
            const item = b36(emailIndex.get(es[0])) + '~' + b36(emailIndex.get(es[1]));
            const cost = bytes(item) + 1;
            if (used + cost > TOTAL_BUDGET) { dropped.pairAcks++; continue; }
            used += cost; pItems.push(item);
        }

        // --- threads（メンバーは採用済み宛先のみ、hash が安全な場合） ---
        const tItems = [];
        for (const hash of Object.keys(threads)) {
            if (!SAFE(hash)) { dropped.threads++; continue; }
            const members = (threads[hash].r || []).filter(e => emailIndex.has(e));
            if (members.length === 0) { dropped.threads++; continue; }
            const item = hash + '~' + members.map(e => b36(emailIndex.get(e))).join(',');
            const cost = bytes(item) + 1;
            if (used + cost > TOTAL_BUDGET) { dropped.threads++; continue; }
            used += cost; tItems.push(item);
        }

        // --- greetAcks（宛名が安全＆宛先採用済みの場合のみ） ---
        const gItems = [];
        for (const key of Object.keys(greetAcks)) {
            const bar = key.lastIndexOf('|');
            if (bar === -1) { dropped.greetAcks++; continue; }
            const name = key.slice(0, bar), email = key.slice(bar + 1);
            if (!SAFE(name) || !emailIndex.has(email)) { dropped.greetAcks++; continue; }
            const item = name + '~' + b36(emailIndex.get(email));
            const cost = bytes(item) + 1;
            if (used + cost > TOTAL_BUDGET) { dropped.greetAcks++; continue; }
            used += cost; gItems.push(item);
        }

        // --- 文字列組み立て（行単位） ---
        const lines = [
            FORMAT,
            b36(stats.sends || 0) + '~' + b36(stats.dialogs || 0) + '~' + b36(stats.autoPass || 0),
            'D ' + domList.join(' '),
            'E ' + eItems.join(' '),
            'K ' + kItems.join(' '),
            'P ' + pItems.join(' '),
            'T ' + tItems.join(' '),
            'G ' + gItems.join(' ')
        ];
        const blob = lines.join('\n');

        // --- シャード分割（UTF-8 で SHARD_MAX 未満、文字境界を割らない） ---
        const shards = {};
        let idx = 0, cur = '', curBytes = 0;
        const flush = () => { if (cur.length) { shards[KEY_PREFIX + idx] = cur; idx++; cur = ''; curBytes = 0; } };
        for (const ch of blob) {
            const cb = bytes(ch);
            if (curBytes + cb > SHARD_MAX) flush();
            cur += ch; curBytes += cb;
        }
        flush();

        const kept = {
            recipients: eItems.length, domains: domList.length, combos: kItems.length,
            pairAcks: pItems.length, greetAcks: gItems.length, threads: tItems.length
        };
        const meta = { v: FORMAT, n: idx, kept, dropped, bytes: bytes(blob) };
        shards[META_KEY] = JSON.stringify(meta);
        return { shards, meta };
    }

    /**
     * シャード（{psg_y0:..., psg_ymeta:...}）を db 断片に復元する。
     * @returns {{recipients,domains,combos,pairAcks,greetAcks,threads,stats}|null}
     */
    function decode(items) {
        if (!items) return null;
        let metaRaw = items[META_KEY];
        let n = 0;
        if (metaRaw) { try { n = JSON.parse(metaRaw).n || 0; } catch (e) { n = 0; } }
        // シャード結合（連番）
        let blob = '';
        if (n > 0) {
            for (let i = 0; i < n; i++) { if (items[KEY_PREFIX + i] == null) return null; blob += items[KEY_PREFIX + i]; }
        } else {
            // n 不明時はキーを昇順で拾う
            const keys = Object.keys(items).filter(k => k.startsWith(KEY_PREFIX))
                .sort((a, b) => p36(a.slice(KEY_PREFIX.length)) - p36(b.slice(KEY_PREFIX.length)));
            for (const k of keys) blob += items[k];
        }
        if (!blob) return null;

        const lines = blob.split('\n');
        if (lines[0] !== FORMAT) return null;
        const out = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {}, stats: { sends: 0, dialogs: 0, autoPass: 0 } };

        // stats
        if (lines[1]) { const s = lines[1].split('~'); out.stats = { sends: p36(s[0]), dialogs: p36(s[1]), autoPass: p36(s[2]) }; }

        const sec = {};
        for (const line of lines.slice(2)) {
            const tag = line[0];
            sec[tag] = line.length > 2 ? line.slice(2) : '';
        }
        const domList = (sec.D || '').split(' ').filter(Boolean);
        const emailList = [];
        const now = Date.now ? nowSafe() : 1;

        // 宛先（新しい順に並んでいるので、順序で recency を再現）
        const eParts = (sec.E || '').split(' ').filter(Boolean);
        eParts.forEach((item, i) => {
            const f = item.split('~');
            const lp = f[0], dm = domList[p36(f[1])] || '', c = p36(f[2]) || 1;
            if (!dm) { emailList.push(null); return; }
            const email = (lp + '@' + dm).toLowerCase();
            emailList.push(email);
            out.recipients[email] = { c, t: now - i, n: '' };
            const dcur = out.domains[dm] || { c: 0, t: now - i };
            dcur.c += c; out.domains[dm] = dcur;
        });

        for (const item of (sec.K || '').split(' ').filter(Boolean)) {
            const f = item.split('~'); const a = domList[p36(f[0])], b = domList[p36(f[1])];
            if (a && b) out.combos[[a, b].sort().join('|')] = now;
        }
        for (const item of (sec.P || '').split(' ').filter(Boolean)) {
            const f = item.split('~'); const a = emailList[p36(f[0])], b = emailList[p36(f[1])];
            if (a && b) out.pairAcks[[a, b].sort().join('|')] = now;
        }
        for (const item of (sec.T || '').split(' ').filter(Boolean)) {
            const f = item.split('~'); const hash = f[0];
            const r = (f[1] || '').split(',').filter(Boolean).map(x => emailList[p36(x)]).filter(Boolean);
            if (hash && r.length) out.threads[hash] = { r, t: now };
        }
        for (const item of (sec.G || '').split(' ').filter(Boolean)) {
            const bar = item.lastIndexOf('~'); if (bar === -1) continue;
            const name = item.slice(0, bar), email = emailList[p36(item.slice(bar + 1))];
            if (name && email) out.greetAcks[name + '|' + email] = now;
        }
        return out;
    }

    // Date.now が使えない環境（ワークフロー等）向けの保険
    function nowSafe() { try { return Date.now(); } catch (e) { return 1; } }

    /**
     * incoming（他PC由来の db 断片）を target にマージする。
     * 何度マージしても結果が変わらない冪等な統合（max を採る）により、
     * 複数PC間で onChanged が飛び交っても収束する。
     * @returns {boolean} target が変化したか
     */
    function merge(target, incoming) {
        if (!incoming) return false;
        let changed = false;
        const R = target.recipients || (target.recipients = {});
        for (const e of Object.keys(incoming.recipients || {})) {
            const inc = incoming.recipients[e], cur = R[e];
            if (!cur) { R[e] = { c: inc.c || 1, t: inc.t || 0, n: inc.n || '' }; changed = true; }
            else {
                if ((inc.c || 0) > cur.c) { cur.c = inc.c; changed = true; }
                if ((inc.t || 0) > cur.t) { cur.t = inc.t; changed = true; }
                if (!cur.n && inc.n) { cur.n = inc.n; changed = true; }
            }
        }
        const D = target.domains || (target.domains = {});
        for (const d of Object.keys(incoming.domains || {})) {
            const inc = incoming.domains[d], cur = D[d];
            if (!cur) { D[d] = { c: inc.c || 1, t: inc.t || 0 }; changed = true; }
            else {
                if ((inc.c || 0) > cur.c) { cur.c = inc.c; changed = true; }
                if ((inc.t || 0) > cur.t) { cur.t = inc.t; changed = true; }
            }
        }
        for (const mapName of ['combos', 'pairAcks', 'greetAcks']) {
            const T = target[mapName] || (target[mapName] = {});
            const inc = incoming[mapName] || {};
            for (const k of Object.keys(inc)) {
                if (!(k in T) || inc[k] > T[k]) { T[k] = inc[k]; changed = true; }
            }
        }
        const TH = target.threads || (target.threads = {});
        for (const h of Object.keys(incoming.threads || {})) {
            const inc = incoming.threads[h], cur = TH[h];
            if (!cur) { TH[h] = { r: (inc.r || []).slice(), t: inc.t || 0 }; changed = true; }
            else {
                const before = cur.r.length;
                cur.r = [...new Set(cur.r.concat(inc.r || []))];
                if (cur.r.length !== before) changed = true;
                if ((inc.t || 0) > cur.t) { cur.t = inc.t; changed = true; }
            }
        }
        return changed;
    }

    const SyncCodec = { encode, decode, merge, bytes, FORMAT, TOTAL_BUDGET, SHARD_MAX, KEY_PREFIX, META_KEY };
    if (typeof module !== 'undefined' && module.exports) module.exports = SyncCodec;
    root.PSG_SyncCodec = SyncCodec;
})(typeof globalThis !== 'undefined' ? globalThis : this);
