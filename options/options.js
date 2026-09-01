/* options.js — 設定画面。PSG_Store（chrome.storage.local）を直接読み書きする */
(function () {
    'use strict';
    const Store = globalThis.PSG_Store;

    // i18n 反映
    for (const el of document.querySelectorAll('[data-i18n]')) {
        el.textContent = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    }
    for (const el of document.querySelectorAll('[data-i18n-ph]')) {
        el.setAttribute('placeholder', chrome.i18n.getMessage(el.getAttribute('data-i18n-ph')));
    }
    document.title = chrome.i18n.getMessage('opt_title');

    const BOOL_KEYS = [
        'checkFirstRecipient', 'checkLookalike', 'checkNewCombo', 'checkManyVisible',
        'checkKnownLookalike', 'checkGreeting', 'checkThreadDelta', 'checkSkipInternal',
        'strictMode', 'learnEnabled', 'showToast'
        // syncEnabled は専用ハンドラ（ON にしたら即取り込み）で扱うため BOOL_KEYS に含めない
    ];

    let savedTimer = 0;
    function flashSaved() {
        const el = document.getElementById('saved');
        el.classList.add('show');
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => el.classList.remove('show'), 1200);
    }

    async function init() {
        const settings = await Store.getSettings();
        for (const key of BOOL_KEYS) {
            const box = document.getElementById(key);
            box.checked = !!settings[key];
            box.addEventListener('change', async () => {
                await Store.setSettings({ [key]: box.checked });
                flashSaved();
            });
        }
        const th = document.getElementById('manyVisibleThreshold');
        th.value = settings.manyVisibleThreshold;
        th.addEventListener('change', async () => {
            const v = Math.max(2, Math.min(100, parseInt(th.value, 10) || 5));
            th.value = v;
            await Store.setSettings({ manyVisibleThreshold: v });
            flashSaved();
        });

        // 端末間同期トグル（ON にしたら即座に取り込み＋書き出し）
        const syncBox = document.getElementById('syncEnabled');
        syncBox.checked = settings.syncEnabled !== false;
        syncBox.addEventListener('change', async () => {
            if (Store.setSyncEnabled) await Store.setSyncEnabled(syncBox.checked);
            else await Store.setSettings({ syncEnabled: syncBox.checked });
            flashSaved();
            setTimeout(refreshSyncInfo, 500);
        });

        await refreshStats();
        refreshSyncInfo();
        refreshStatus();
        await refreshRecipients();

        document.getElementById('clear').addEventListener('click', async () => {
            if (!confirm(chrome.i18n.getMessage('opt_clear_confirm'))) return;
            await Store.clearHistory();
            await refreshStats();
            refreshSyncInfo();
            await refreshRecipients();
            flashSaved();
        });

        // 直近の学習を取り消す（Undo Send 後の毒抜き）
        const undoBtn = document.getElementById('undo');
        undoBtn.addEventListener('click', async () => {
            if (Store.undoLastLearn) await Store.undoLastLearn();
            await refreshStats();
            await refreshRecipients();
            flashSaved();
        });
        undoBtn.style.display = (Store.hasUndo && Store.hasUndo()) ? '' : 'none';

        // 宛先検索でリストを絞り込み
        document.getElementById('recipSearch').addEventListener('input', (e) => {
            renderRecipients(e.target.value.trim().toLowerCase());
        });

        // レビュー・フィードバックの常設リンク（開くだけ。データ送信はしない）
        const Gate = globalThis.PSG_ReviewGate;
        if (Gate && Gate.urls) {
            const urls = Gate.urls();
            const rv = document.getElementById('reviewLink');
            const fb = document.getElementById('feedbackLink');
            if (urls.review) rv.href = urls.review;
            else rv.style.display = 'none'; // 開発版などストア URL を作れない環境では隠す
            fb.href = urls.feedback;
        }
    }

    let allRecipients = [];
    async function refreshRecipients() {
        const db = await Store.getHistory();
        allRecipients = Object.keys(db.recipients).map(email => ({
            email, c: db.recipients[email].c || 0, n: db.recipients[email].n || '', t: db.recipients[email].t || 0
        })).sort((a, b) => b.t - a.t);
        renderRecipients(document.getElementById('recipSearch').value.trim().toLowerCase());
    }

    function renderRecipients(filter) {
        const list = document.getElementById('recipList');
        list.textContent = '';
        let rows = allRecipients;
        if (filter) rows = rows.filter(r => r.email.includes(filter) || r.n.toLowerCase().includes(filter));
        rows = rows.slice(0, 200); // 表示は最大200件（検索で絞り込み）
        if (rows.length === 0) { return; }
        for (const r of rows) {
            const row = document.createElement('div');
            row.className = 'reciprow';
            const em = document.createElement('span');
            em.className = 'em';
            if (r.n) { const b = document.createElement('b'); b.textContent = r.n + ' '; em.appendChild(b); }
            em.appendChild(document.createTextNode('<' + r.email + '>'));
            const btn = document.createElement('button');
            btn.textContent = chrome.i18n.getMessage('opt_forget');
            btn.addEventListener('click', async () => {
                if (Store.forgetRecipient) await Store.forgetRecipient(r.email);
                await refreshRecipients();
                await refreshStats();
                flashSaved();
            });
            row.appendChild(em);
            row.appendChild(btn);
            list.appendChild(row);
        }
    }

    function refreshStatus() {
        const el = document.getElementById('statusLine');
        if (!el || !Store.getStatus) { return; }
        const st = Store.getStatus();
        let msg = '';
        if (st.localError) msg = chrome.i18n.getMessage('opt_local_error', [st.localError]);
        else if (st.syncState === 'error' && st.syncError) msg = chrome.i18n.getMessage('opt_sync_status_error', [st.syncError]);
        el.textContent = msg;
    }

    async function refreshStats() {
        const db = await Store.getHistory();
        document.getElementById('stats').textContent = chrome.i18n.getMessage('opt_stats', [
            String(Object.keys(db.recipients).length),
            String(db.stats.sends)
        ]);
    }

    function refreshSyncInfo() {
        const el = document.getElementById('syncInfo');
        if (!el || !Store.getSyncInfo) return;
        const info = Store.getSyncInfo();
        const box = document.getElementById('syncEnabled');
        if (!box.checked) { el.textContent = ''; return; }
        if (!info || !info.kept) { el.textContent = ''; return; }
        const kb = Math.round((info.bytes || 0) / 1024);
        const dropped = info.dropped ? Object.values(info.dropped).reduce((a, b) => a + b, 0) : 0;
        el.textContent = chrome.i18n.getMessage('opt_sync_info', [
            String(info.kept.recipients || 0), String(kb), String(dropped)
        ]);
    }

    init();
})();
