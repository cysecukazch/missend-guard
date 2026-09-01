/**
 * ui.js — 確認ダイアログとトースト。Shadow DOM で Gmail の CSS から隔離する。
 *
 * デザイン: Google の Material トンマナに準拠。
 *   - Gmail のダークテーマを自動検出し、ライト/ダークの両パレットに追従する
 *   - キーボード完全対応（Tab 循環・Space/Enter でカード確認・Esc でキャンセル）
 *   - prefers-reduced-motion を尊重
 *
 * 形骸化対策としての UI 原則:
 *   - ダイアログは「異常があるときだけ」出す（普段は出ない → 出たときは読む）
 *   - すべての異常を個別に確認するまで送信ボタンは有効化しない
 *   - Enter を既定ボタンとして扱わない（フォーカス中の要素のみ操作。勢いの Enter はカード確認止まり）
 *   - 表示直後 400ms はクリックを無視（ダブルクリック貫通を防ぐ）
 */
(function (root) {
    'use strict';

    function msg(key, subs) {
        try {
            const m = chrome.i18n.getMessage(key, subs);
            if (m) return m;
        } catch (e) { /* テスト環境 */ }
        const dict = root.PSG_TEST_MESSAGES || {};
        let s = (dict[key] && dict[key].message) || '';
        (subs || []).forEach((v, i) => { s = s.replace(new RegExp('\\$' + (i + 1), 'g'), v); });
        return s;
    }

    /** 異常タイプごとの Material アイコン（24x24 パス） */
    const ICONS = {
        first_recipients: 'M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
        known_lookalike: 'M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
        greeting_mismatch: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
        greeting_mismatch_suggest: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
        thread_new: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z',
        new_combo: 'M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z',
        many_visible: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
        read_failed: 'M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm.01 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z'
    };
    const ICON_DEFAULT = ICONS.read_failed;

    function svgIcon(d, cls) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        if (cls) svg.setAttribute('class', cls);
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
        return svg;
    }
    function iconEl(type) {
        return svgIcon(ICONS[type] || ICON_DEFAULT, 'icon');
    }
    // ヘッダ用: 異常あり=注意三角、異常なし=チェック丸
    const HEAD_CAUTION = 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z';
    const HEAD_CLEAN = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z';
    function headerIcon(hasAnomaly) {
        return svgIcon(hasAnomaly ? HEAD_CAUTION : HEAD_CLEAN);
    }

    /*
     * パレットは CSS カスタムプロパティで定義し、:host の data-psg-theme 属性で切替。
     * ライト/ダークとも Google の配色（#1a73e8 / #8ab4f8 等）に合わせる。
     */
    const CSS = `
        :host { all: initial; }
        :host {
            --surface: #fff;
            --surface-2: #f8f9fa;
            --ink: #202124;
            --muted: #5f6368;
            --line: #e8eaed;
            --accent: #1a73e8;
            --accent-hover: #1765cc;
            --on-accent: #fff;
            --warn: #d93025;
            /* caution=琥珀（Gmailの「ご注意」バナー系）。赤より穏やかに確認を促す */
            --attention: #a85800;
            --attention-bg: #feefc3;
            --caution-text: #b06000;
            --caution-band: #fef7e0;
            --done: #137333;
            --done-bg: #e6f4ea;
            --ack-card: #f1f7f3;
            --btn-dis-bg: rgba(60,64,67,.12);
            --btn-dis-fg: #9aa0a6;
            --accent-soft: rgba(26,115,232,.06);
            --scrim: rgba(32,33,36,.5);
            --toast-bg: #202124;
            --toast-fg: #e8eaed;
            --toast-ok: #81c995;
            --tag-to-fg: #c5221f;  --tag-to-bg: #fce8e6;
            --tag-cc-fg: #137333;  --tag-cc-bg: #e6f4ea;
            --tag-bcc-fg: #185abc; --tag-bcc-bg: #e8f0fe;
            --code-fg: #3c4043;
        }
        :host([data-psg-theme="dark"]) {
            --surface: #2d2e31;
            --surface-2: #35363a;
            --ink: #e8eaed;
            --muted: #9aa0a6;
            --line: #47484c;
            --accent: #8ab4f8;
            --accent-hover: #aecbfa;
            --on-accent: #202124;
            --warn: #f28b82;
            --attention: #fdd663;
            --attention-bg: rgba(249,171,0,.15);
            --caution-text: #fdd663;
            --caution-band: rgba(249,171,0,.10);
            --done: #81c995;
            --done-bg: rgba(129,201,149,.15);
            --ack-card: #313337;
            --btn-dis-bg: rgba(232,234,237,.12);
            --btn-dis-fg: #80868b;
            --accent-soft: rgba(138,180,248,.10);
            --scrim: rgba(0,0,0,.6);
            --toast-bg: #e8eaed;
            --toast-fg: #202124;
            --toast-ok: #0d652d;
            --tag-to-fg: #f6aea9;  --tag-to-bg: rgba(242,139,130,.12);
            --tag-cc-fg: #81c995;  --tag-cc-bg: rgba(129,201,149,.15);
            --tag-bcc-fg: #8ab4f8; --tag-bcc-bg: rgba(138,180,248,.15);
            --code-fg: #bdc1c6;
        }
        * { box-sizing: border-box; font-family: 'Google Sans', Roboto, 'Hiragino Sans', 'Noto Sans JP', Meiryo, sans-serif; }
        .overlay {
            position: fixed; inset: 0; background: var(--scrim);
            z-index: 2147483646; display: flex; align-items: flex-start; justify-content: center;
        }
        .modal {
            margin-top: 8vh; width: min(520px, 92vw); max-height: 80vh;
            background: var(--surface); border-radius: 16px; color: var(--ink);
            box-shadow: 0 4px 8px 3px rgba(0,0,0,.15), 0 1px 3px rgba(0,0,0,.3);
            display: flex; flex-direction: column; overflow: hidden;
            animation: pop .15s ease-out;
        }
        @keyframes pop { from { transform: scale(.97); opacity: .6; } to { transform: none; opacity: 1; } }
        /* ヘッダ: Gmail の「ご注意」バナー風に、琥珀の帯＋アイコンで一目で用件が伝わる */
        .head { display: flex; gap: 12px; align-items: center; padding: 16px 20px; background: var(--caution-band); }
        .head.clean { background: var(--done-bg); }
        .head .hicon { flex: none; width: 22px; height: 22px; }
        .head .hicon svg { width: 22px; height: 22px; }
        .head.caution .hicon svg { fill: var(--caution-text); }
        .head.clean .hicon svg { fill: var(--done); }
        .title { font-size: 15px; font-weight: 500; color: var(--ink); }
        .sub { font-size: 12.5px; color: var(--muted); margin-top: 1px; }
        .body { padding: 8px 8px; overflow-y: auto; }
        /* 注: この環境では var() ベースの色プロパティに transition を掛けると遷移が
           完了せず初期値に固着する。確認状態（琥珀→緑）の色変化は transition を使わず
           即時反映にする（クラス付与だけで確実に切り替わる。フェードより確実さを優先） */
        .card {
            display: flex; gap: 12px; align-items: flex-start;
            padding: 12px 14px; margin: 2px 4px; border-radius: 12px; cursor: pointer;
        }
        .card:hover { background-color: var(--surface-2); }
        .card:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
        .card.acked { cursor: default; background-color: var(--ack-card); }
        .card.acked:hover { background-color: var(--ack-card); }
        /* アイコンを円形チップに入れてスキャンしやすく（Gmail のカテゴリチップ風） */
        .iconwrap {
            flex: none; width: 32px; height: 32px; border-radius: 50%;
            background-color: var(--attention-bg); display: flex; align-items: center; justify-content: center;
        }
        .card.acked .iconwrap { background-color: var(--done-bg); }
        .icon { width: 18px; height: 18px; fill: var(--attention); }
        .card.acked .icon { fill: var(--done); }
        .ring {
            flex: none; width: 20px; height: 20px; margin-top: 6px;
            border: 2px solid var(--attention); border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
        }
        .card.acked .ring { border-color: var(--done); background-color: var(--done); }
        .card.acked .ring::after { content: '✓'; color: var(--surface); font-size: 12px; font-weight: 700; }
        .cardbody { min-width: 0; flex: 1; padding-top: 1px; }
        .cardtitle { font-size: 14px; font-weight: 500; color: var(--ink); line-height: 1.45; }
        .carddetail { font-size: 12.5px; color: var(--muted); margin-top: 2px; line-height: 1.5; }
        .rows { margin: 6px 0 0; padding: 0 0 0 12px; list-style: none; border-left: 2px solid var(--line); }
        .rows li {
            font-family: 'Roboto Mono', Consolas, monospace; font-size: 12px;
            color: var(--code-fg); padding: 3px 0;
            display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline;
        }
        .rows .tag {
            font-family: inherit; font-size: 11px; font-weight: 700;
            padding: 1px 7px; border-radius: 10px;
        }
        .tag.to  { color: var(--tag-to-fg);  background: var(--tag-to-bg); }
        .tag.cc  { color: var(--tag-cc-fg);  background: var(--tag-cc-bg); }
        .tag.bcc { color: var(--tag-bcc-fg); background: var(--tag-bcc-bg); }
        .rows .mail { word-break: break-all; }
        .rows .note {
            width: 100%; font-family: inherit; font-size: 12px; color: var(--caution-text);
            padding: 3px 8px; margin-left: 14px; border-radius: 6px; background: var(--caution-band);
        }
        .reciplist { margin: 4px 12px 0; }
        .reciplist summary {
            font-size: 13px; color: var(--accent); cursor: pointer; user-select: none;
            padding: 8px 4px; border-radius: 8px; list-style-position: inside;
        }
        .reciplist summary:hover { background: var(--surface-2); }
        .reciplist summary:focus-visible { outline: 2px solid var(--accent); }
        .domain { margin: 2px 0 8px 12px; }
        .domain .dname { font-size: 12px; font-weight: 500; color: var(--muted); font-family: 'Roboto Mono', monospace; }
        .domain .rows { margin-left: 2px; }
        .meta {
            margin: 10px 16px 4px; padding-top: 12px; border-top: 1px solid var(--line);
            font-size: 12.5px; color: var(--muted);
        }
        .foot {
            display: flex; gap: 8px; align-items: center; padding: 12px 20px 16px;
            border-top: 1px solid var(--line);
        }
        .hint { font-size: 12px; color: var(--muted); flex: 1; }
        button {
            border: none; border-radius: 20px; padding: 9px 24px;
            font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit;
        }
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .btn-cancel { background: none; color: var(--accent); }
        .btn-cancel:hover { background: var(--accent-soft); }
        .btn-send { background: var(--accent); color: var(--on-accent); }
        .btn-send:hover:not(:disabled) { background: var(--accent-hover); box-shadow: 0 1px 2px rgba(0,0,0,.3); }
        .btn-send:disabled { background: var(--btn-dis-bg); color: var(--btn-dis-fg); cursor: default; }
        .toast {
            position: fixed; right: 24px; bottom: 24px; z-index: 2147483646;
            background: var(--toast-bg); color: var(--toast-fg); border-radius: 8px; padding: 13px 18px;
            font-size: 13.5px; box-shadow: 0 3px 10px rgba(0,0,0,.3);
            display: flex; gap: 10px; align-items: center;
            animation: rise .2s ease-out;
        }
        @keyframes rise { from { transform: translateY(10px); opacity: 0; } to { transform: none; opacity: 1; } }
        .toast .ok { color: var(--toast-ok); font-weight: 700; }
        @media (prefers-reduced-motion: reduce) {
            .modal, .toast { animation: none; }
            .card, .iconwrap, .ring { transition: none; }
        }
        /* Windows ハイコントラスト等: 面ではなく線で領域・状態を示す */
        @media (forced-colors: active) {
            .modal { border: 1px solid CanvasText; }
            .head, .foot { border-color: CanvasText; }
            .iconwrap, .card.acked { border: 1px solid CanvasText; }
            .ring { border-color: CanvasText; }
            .card.acked .ring { background-color: Highlight; }
            button { border: 1px solid ButtonBorder; }
            .btn-send:disabled { border-color: GrayText; color: GrayText; }
        }
        .foothint { font-size: 11.5px; color: var(--muted); line-height: 1.5; padding: 0 20px 8px; }
        .footlinks { display: flex; gap: 14px; padding: 0 20px 12px; }
        .footlinks a { font-size: 12px; color: var(--accent); text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
        .footlinks a:hover { text-decoration: underline; }
        .footlinks svg { width: 14px; height: 14px; fill: var(--accent); }
        .rowmore { font-size: 12px; color: var(--muted); padding: 3px 0 0 0; font-family: 'Roboto Mono', monospace; }
        /* レビューのお願い（一度きりの控えめなカード）。通常トーストと重ならない高さに置く */
        .rvcard {
            position: fixed; right: 24px; bottom: 84px; z-index: 2147483646;
            width: min(340px, calc(100vw - 48px));
            background: var(--surface); color: var(--ink);
            border: 1px solid var(--line); border-radius: 12px;
            box-shadow: 0 4px 12px rgba(0,0,0,.25);
            padding: 14px 16px; animation: rise .2s ease-out;
        }
        .rvhead { display: flex; gap: 10px; align-items: flex-start; }
        .rvicon { flex: none; width: 20px; height: 20px; margin-top: 1px; }
        .rvicon svg { width: 20px; height: 20px; fill: var(--accent); }
        .rvtext { flex: 1; font-size: 13.5px; line-height: 1.55; }
        .rvx {
            flex: none; background: none; border: none; padding: 2px 7px; margin: -4px -7px 0 0;
            cursor: pointer; color: var(--muted); font-size: 14px; border-radius: 50%; line-height: 1.4;
        }
        .rvx:hover { background: var(--surface-2); }
        .rvbtns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
        .rvbtns button { padding: 7px 16px; font-size: 13px; }
        /* SR 通知用（視覚上は隠すが読み上げ対象に残す） */
        .rvlive {
            position: absolute; width: 1px; height: 1px; overflow: hidden;
            clip-path: inset(50%); white-space: nowrap;
        }
        @media (prefers-reduced-motion: reduce) { .rvcard { animation: none; } }
        @media (forced-colors: active) { .rvcard { border: 1px solid CanvasText; } }
    `;

    let openHost = null;

    /**
     * Gmail のダークテーマ検出。コンポーズ周辺の実背景色の輝度で判定し、
     * 取得できない場合は OS の配色設定にフォールバックする。
     */
    function detectDark() {
        try {
            let el = document.querySelector('div[role="dialog"], div.aoI') || document.body;
            while (el && el !== document.documentElement) {
                const c = getComputedStyle(el).backgroundColor;
                const m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) {
                    const lum = 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3];
                    return lum < 128;
                }
                el = el.parentElement;
            }
        } catch (e) { /* fall through */ }
        try {
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch (e) { return false; }
    }

    function makeHost() {
        const host = document.createElement('div');
        host.id = 'psg-host-' + Date.now();
        host.setAttribute('data-psg-theme', detectDark() ? 'dark' : 'light');
        // closed Shadow: host.shadowRoot が外部（ページ JS・他拡張の content script）から
        // null になり、ダイアログに載る履歴由来の候補アドレスを読み取れなくする。
        // shadow 参照は呼び出し側のクロージャ内にのみ保持する。
        // PSG_TEST_OPEN_SHADOW はテストハーネス専用（content script は隔離ワールドのため
        // ページ側からこのフラグを立てることはできず、本番では常に closed）。
        const shadow = host.attachShadow({ mode: root.PSG_TEST_OPEN_SHADOW ? 'open' : 'closed' });
        const style = document.createElement('style');
        style.textContent = CSS;
        shadow.appendChild(style);
        (document.body || document.documentElement).appendChild(host);
        return { host, shadow };
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    /** 拡張内ページ（設定・ヘルプ）を新しいタブで開く */
    function openExtPage(path) {
        try {
            if (chrome.runtime && chrome.runtime.openOptionsPage && path.indexOf('options') === 0) {
                chrome.runtime.openOptionsPage(); return;
            }
            const url = chrome.runtime.getURL(path);
            window.open(url, '_blank', 'noopener');
        } catch (e) { /* ignore */ }
    }

    function fieldTag(field) {
        return el('span', 'tag ' + (field === 'to' || field === 'cc' || field === 'bcc' ? field : ''),
            field.toUpperCase());
    }

    function recipientLine(row) {
        const li = el('li');
        li.appendChild(fieldTag(row.field));
        li.appendChild(el('span', 'mail', (row.name ? row.name + ' ' : '') + '<' + row.email + '>'));
        return li;
    }

    /** 異常カード（クリック / Space / Enter で確認済みにする） */
    function buildCard(anomaly, onChange, clickGuard) {
        const card = el('div', 'card');
        card.setAttribute('role', 'checkbox');
        card.setAttribute('aria-checked', 'false');
        card.tabIndex = 0;
        const iconWrap = el('div', 'iconwrap');
        iconWrap.appendChild(iconEl(anomaly.type));
        card.appendChild(iconWrap);
        const body = el('div', 'cardbody');
        // 文言が未定義でも無文字カードにしない（i18n 網羅テストの最終防衛線）
        const title = msg('an_' + anomaly.type + '_title', anomaly.params) || anomaly.type;
        body.appendChild(el('div', 'cardtitle', title));
        // SR 向けにカード（checkbox）の読み上げ名を要約に固定
        // （宛先全アドレスがアクセシブル名に連結されるのを防ぐ）
        card.setAttribute('aria-label', title);
        const detail = msg('an_' + anomaly.type + '_detail', anomaly.params);
        if (detail) body.appendChild(el('div', 'carddetail', detail));
        if (anomaly.rows) {
            const ul = el('ul', 'rows');
            const MAX_ROWS = 5;
            const shown = anomaly.rows.slice(0, MAX_ROWS);
            for (const row of shown) {
                const li = recipientLine(row);
                for (const note of (row.notes || [])) {
                    li.appendChild(el('span', 'note', msg('note_' + note.type, note.params)));
                }
                ul.appendChild(li);
            }
            body.appendChild(ul);
            if (anomaly.rows.length > MAX_ROWS) {
                body.appendChild(el('div', 'rowmore', msg('andMore', [String(anomaly.rows.length - MAX_ROWS)])));
            }
        }
        card.appendChild(body);
        card.appendChild(el('span', 'ring'));
        const ack = () => {
            if (card.classList.contains('acked')) return;
            card.classList.add('acked');
            card.setAttribute('aria-checked', 'true');
            onChange();
        };
        // クリックにも 400ms ガードを適用（送信ボタンのダブルクリックがモーダル上に
        // 落ちて、読まれないままカードが確認済みになるのを防ぐ）
        card.addEventListener('click', clickGuard ? clickGuard(ack) : ack);
        card.addEventListener('keydown', (e) => {
            // フォーカス中のカードは Space / Enter で確認できる。
            // stopPropagation で Gmail・送信ボタンへは伝播させない
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                ack();
            }
        });
        return card;
    }

    /** ドメイン別の全宛先リスト（参考表示） */
    function buildRecipientList(recipients, expanded) {
        const wrap = el('details', 'reciplist');
        if (expanded) wrap.open = true;
        wrap.appendChild(el('summary', '', msg('dlgAllRecipients', [String(recipients.length)])));
        const byDomain = {};
        for (const r of recipients) {
            (byDomain[r.domain] = byDomain[r.domain] || []).push(r);
        }
        for (const domain of Object.keys(byDomain).sort()) {
            const d = el('div', 'domain');
            d.appendChild(el('div', 'dname', '@' + domain));
            const ul = el('ul', 'rows');
            for (const r of byDomain[domain].sort((a, b) => a.email < b.email ? -1 : 1)) {
                ul.appendChild(recipientLine(r));
            }
            d.appendChild(ul);
            wrap.appendChild(d);
        }
        return wrap;
    }

    /**
     * 確認ダイアログを開く。
     * @param opt {{anomalies, recipients, mail, onSend, onCancel}}
     */
    function openDialog(opt) {
        if (openHost) return; // 二重表示防止
        const opener = document.activeElement; // 閉じたときにフォーカスを返す
        const { host, shadow } = makeHost();
        openHost = host;
        const openedAt = Date.now();
        const guard = (fn) => (ev) => {
            if (Date.now() - openedAt < 400) return; // クリック貫通防止
            fn(ev);
        };

        const overlay = el('div', 'overlay');
        const modal = el('div', 'modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        overlay.appendChild(modal);

        const hasAnomaly = opt.anomalies.length > 0;
        const head = el('div', 'head ' + (hasAnomaly ? 'caution' : 'clean'));
        const hicon = el('span', 'hicon');
        hicon.appendChild(headerIcon(hasAnomaly));
        head.appendChild(hicon);
        const htext = el('div');
        const titleEl = el('div', 'title', msg('dlgTitle'));
        titleEl.id = 'psg-dlg-title';
        modal.setAttribute('aria-labelledby', titleEl.id);
        htext.appendChild(titleEl);
        const subEl = el('div', 'sub', hasAnomaly
            ? msg('dlgSubAnomalies', [String(opt.anomalies.length)])
            : msg('dlgSubStrict'));
        subEl.id = 'psg-dlg-sub';
        modal.setAttribute('aria-describedby', subEl.id);
        htext.appendChild(subEl);
        head.appendChild(htext);
        modal.appendChild(head);

        // スクロール領域はキーボードでも到達・スクロールできるように
        const body = el('div', 'body');
        body.tabIndex = 0;
        body.setAttribute('role', 'region');
        body.setAttribute('aria-labelledby', titleEl.id);
        let remaining = opt.anomalies.length;
        const sendBtn = el('button', 'btn-send', msg('btnSend'));
        const hint = el('span', 'hint');
        hint.setAttribute('aria-live', 'polite'); // 「残り n件」→「送信できます」を SR に通知
        const updateState = () => {
            sendBtn.disabled = remaining > 0;
            hint.textContent = remaining > 0 ? msg('ackHint', [String(remaining)]) : msg('ackAllDone');
        };
        const cards = [];
        const group = el('div');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-labelledby', subEl.id);
        for (const a of opt.anomalies) {
            const c = buildCard(a, () => { remaining -= 1; updateState(); }, guard);
            cards.push(c);
            group.appendChild(c);
        }
        body.appendChild(group);
        body.appendChild(buildRecipientList(opt.recipients, !hasAnomaly));

        const meta = el('div', 'meta');
        const subj = (opt.mail.subject || '').trim();
        const parts = [msg('lblSubject') + ': ' + (subj || '—')];
        if (opt.mail.attachments && opt.mail.attachments.length) {
            parts.push(msg('lblAttachments') + ': ' + opt.mail.attachments.join(' / '));
        }
        meta.textContent = parts.join('　·　');
        body.appendChild(meta);
        modal.appendChild(body);

        // 安心のための一言（初回体験の要）: 学習で次から静かになることを伝える。
        // 学習で沈静化しない項目（BCC提案・読み取り失敗）だけのダイアログや学習OFF時には
        // 出さない（「次回から表示されません」が嘘になるため）
        const learnable = (opt.anomalies || []).some(a =>
            a.type !== 'many_visible' && a.type !== 'read_failed');
        if (hasAnomaly && learnable && opt.learnEnabled !== false) {
            const early = (typeof opt.sends === 'number' && opt.sends < 8);
            const hintText = early
                ? msg('reassureEarly')   // 初期: 使うほど確認は減る
                : msg('reassureConfirm'); // 通常: 確認して送れば次から出ない
            if (hintText) modal.appendChild(el('div', 'foothint', hintText));
        }

        const foot = el('div', 'foot');
        const cancelBtn = el('button', 'btn-cancel', msg('btnCancel'));
        foot.appendChild(hint);
        foot.appendChild(cancelBtn);
        foot.appendChild(sendBtn);
        modal.appendChild(foot);

        // Gmail 画面内から常に設定・仕様へ到達できる導線（ツールバーアイコンに気づけない人向け）
        const links = el('div', 'footlinks');
        const gear = el('a', '', '');
        gear.appendChild(svgIcon('M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z'));
        gear.appendChild(el('span', '', msg('linkSettings')));
        gear.addEventListener('click', () => openExtPage('options/options.html'));
        const helpLink = el('a', '', '');
        helpLink.appendChild(svgIcon('M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z'));
        helpLink.appendChild(el('span', '', msg('linkHelp')));
        helpLink.addEventListener('click', () => openExtPage('help/help.html'));
        links.appendChild(gear);
        links.appendChild(helpLink);
        modal.appendChild(links);
        updateState();

        // 背景の Gmail を inert 化（SR 仮想カーソルがゲートを迂回しないように）
        const bg = [...(document.body ? document.body.children : [])].filter(c => c !== host);
        for (const c of bg) { try { c.setAttribute('inert', ''); c.setAttribute('aria-hidden', 'true'); } catch (e) {} }

        const close = () => {
            for (const c of bg) { try { c.removeAttribute('inert'); c.removeAttribute('aria-hidden'); } catch (e) {} }
            host.remove();
            openHost = null;
            document.removeEventListener('keydown', onKey, true);
            // 呼び出し元（コンポーズ）へフォーカスを返す。送信時は Gmail が
            // コンポーズを閉じるため isConnected ガードで自然に no-op になる
            if (opener && opener.isConnected) {
                try { opener.focus(); } catch (e) { /* ignore */ }
            }
        };
        const focusables = () =>
            [...cards, body, ...modal.querySelectorAll('summary, button')].filter(e => !e.disabled);
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                close(); opt.onCancel && opt.onCancel();
                return;
            }
            // フォーカストラップ: Tab をダイアログ内で循環させる
            if (e.key === 'Tab') {
                const f = focusables();
                if (f.length === 0) return;
                const active = shadow.activeElement;
                const idx = f.indexOf(active);
                let next;
                if (e.shiftKey) next = idx <= 0 ? f[f.length - 1] : f[idx - 1];
                else next = idx === -1 || idx === f.length - 1 ? f[0] : f[idx + 1];
                e.preventDefault(); e.stopPropagation();
                next.focus();
            }
            // Enter はここで奪わない＝既定ボタンとしては働かず、フォーカス中の要素だけを操作する
            // （表示直後のフォーカスはカード上のため、勢いの Enter はカード確認止まり）
        };
        document.addEventListener('keydown', onKey, true);

        cancelBtn.addEventListener('click', guard(() => { close(); opt.onCancel && opt.onCancel(); }));
        sendBtn.addEventListener('click', guard(() => {
            if (sendBtn.disabled) return;
            close();
            opt.onSend && opt.onSend();
        }));
        overlay.addEventListener('mousedown', guard((e) => {
            if (e.target === overlay) { close(); opt.onCancel && opt.onCancel(); }
        }));

        shadow.appendChild(overlay);
        // 最初の異常カード（無ければキャンセル）へフォーカスし、即キーボード操作できるように
        // （rAF はタブ非表示中に発火しないため setTimeout を使う）
        setTimeout(() => { if (openHost === host) (cards[0] || cancelBtn).focus(); }, 0);
    }

    /** 素通し時などの小さな通知。シングルトン（連続送信でも重ならず、ライブリージョンも1つ） */
    let toastState = null;
    function toast(text, ms) {
        if (!toastState) {
            const { host, shadow } = makeHost();
            const t = el('div', 'toast');
            t.setAttribute('role', 'status');
            t.setAttribute('aria-live', 'polite');
            t.appendChild(el('span', 'ok', '✓'));
            const textEl = el('span', '');
            t.appendChild(textEl);
            shadow.appendChild(t);
            toastState = { host, textEl, timer: 0 };
        }
        const cur = toastState;
        clearTimeout(cur.timer);
        cur.textEl.textContent = '';
        // ライブリージョンは「空→内容変化」で読み上げられる。既存要素を再利用
        setTimeout(() => { if (toastState === cur) cur.textEl.textContent = text; }, 50);
        cur.timer = setTimeout(() => { cur.host.remove(); if (toastState === cur) toastState = null; }, ms || 2600);
    }

    /**
     * レビューのお願い（一度きりの控えめなカード）。表示条件は src/review-gate.js。
     *   - フォーカスは奪わない（作業中の入力を一切邪魔しない）
     *   - 無操作なら autoHideMs で自動で消える（2段目に進んだら自動では消えない）
     *   - すべての操作（レビュー/要望/✕/今後表示しない）で onAction が呼ばれ、以後は出ない
     * @param opt {{autoHideMs?: number, onAction: (kind:'rate'|'feedback'|'never')=>void, onAutoHide?: ()=>void}}
     */
    function reviewToast(opt) {
        const { host, shadow } = makeHost();
        const card = el('div', 'rvcard');
        card.setAttribute('role', 'group');            // 非モーダル。表示時にフォーカスは移さない
        card.setAttribute('aria-label', msg('rvQ'));
        // SR 通知用のライブリージョン（toast() と同じ「空→内容」パターンで読み上げさせる）。
        // stage() が作り直す本文とは別に、カード内に固定で持つ
        const live = el('span', 'rvlive');
        live.setAttribute('role', 'status');
        card.appendChild(live);
        const bodyEl = el('div');
        card.appendChild(bodyEl);
        let liveTimer = 0;
        function announce(text) {
            clearTimeout(liveTimer);
            live.textContent = '';
            liveTimer = setTimeout(() => { if (host.isConnected) live.textContent = text; }, 50);
        }
        let timer = setTimeout(() => {
            host.remove();
            opt.onAutoHide && opt.onAutoHide();
        }, opt.autoHideMs || 15000);
        const closeWith = (kind) => {
            clearTimeout(timer);
            host.remove();
            opt.onAction && opt.onAction(kind);
        };
        // Esc でも閉じられる（フォーカスがカード内にあるときだけ受け取り、Gmail には伝えない）
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeWith('never');
            }
        });
        const STAR = 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';
        /** カードの中身を差し替える。buttons: [{label, primary, onClick}] */
        function stage(text, buttons) {
            // キーボード操作中（フォーカスがカード内）は、差し替え後に主ボタンへフォーカスを移す
            // （表示直後の初回 stage ではカード内にフォーカスが無いため、何も奪わない）
            const hadFocus = shadow.activeElement && card.contains(shadow.activeElement);
            bodyEl.textContent = '';
            const head = el('div', 'rvhead');
            const ic = el('span', 'rvicon');
            ic.appendChild(svgIcon(STAR));
            head.appendChild(ic);
            head.appendChild(el('div', 'rvtext', text));
            const x = el('button', 'rvx', '✕');
            x.setAttribute('aria-label', msg('rvNever'));
            x.addEventListener('click', () => closeWith('never'));
            head.appendChild(x);
            bodyEl.appendChild(head);
            const btns = el('div', 'rvbtns');
            let primaryBtn = null;
            for (const b of buttons) {
                const btn = el('button', b.primary ? 'btn-send' : 'btn-cancel', b.label);
                btn.addEventListener('click', b.onClick);
                btns.appendChild(btn);
                if (b.primary || !primaryBtn) primaryBtn = btn;
            }
            bodyEl.appendChild(btns);
            announce(text);
            if (hadFocus && primaryBtn) primaryBtn.focus();
        }
        // 1段目に返答してくれたら: 確定を通知し（以後は出ない）、自動消滅は仕切り直す
        // （2段目を読んでいる最中に消さない。残しっぱなしにもしない）
        const engage = () => {
            clearTimeout(timer);
            timer = setTimeout(() => host.remove(), opt.autoHideMs || 15000);
            opt.onEngage && opt.onEngage();
        };
        stage(msg('rvQ'), [
            { label: msg('rvNo'), onClick: () => { engage(); stage(msg('rvSorry'), [
                { label: msg('rvNever'), onClick: () => closeWith('never') },
                { label: msg('rvFeedback'), primary: true, onClick: () => closeWith('feedback') }
            ]); } },
            { label: msg('rvYes'), primary: true, onClick: () => { engage(); stage(msg('rvThanks'), [
                { label: msg('rvNever'), onClick: () => closeWith('never') },
                { label: msg('rvRate'), primary: true, onClick: () => closeWith('rate') }
            ]); } }
        ]);
        shadow.appendChild(card);
    }

    root.PSG_UI = { openDialog, toast, reviewToast, msg };
})(typeof globalThis !== 'undefined' ? globalThis : this);
