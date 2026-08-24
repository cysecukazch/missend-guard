/**
 * gmail-dom.js — Gmail の DOM から送信内容を読み取るセレクタ層。
 * Gmail の難読化クラスは変わりうるため、すべて多段フォールバックにし、
 * どの段が使われたかを診断情報として返せるようにしている。
 *
 * セレクタの根拠（2025-04 時点のストア版 v1.5 と実機確認に基づく）:
 *   - 宛先チップ:  div[name="to|cc|bcc"] 内の div[data-hovercard-id]（2021-10 以降の UI）
 *   - 旧 UI:       input[name="to|cc|bcc"] の value
 *   - 件名:        input[name="subjectbox"]
 *   - 本文:        div[role="textbox"][contenteditable="true"]
 *   - 添付:        .dL .vI（ファイル名） + .vJ（サイズ）
 *   - 送信ボタン:  .btC 内の .T-I.aoO（送信）/ .T-I.Uo（送信してアーカイブ）
 */
(function (root) {
    'use strict';

    const RE = root.PSG_RiskEngine;

    /** 作成画面（コンポーズ）のルート候補。ボタンや入力欄から closest で辿る */
    const COMPOSE_SELECTORS = [
        'div[role="dialog"]',   // ポップアップ形式
        'div.aoI',              // 別ウィンドウ（Shift+クリック）形式
        'div.gA.gt',            // スレッド内の返信フォーム（旧）
        'div.ip.adB',           // スレッド内の返信フォーム
        'div.M9'                // 送信ボタン周辺の外枠（最終フォールバック）
    ];

    function findCompose(el) {
        if (!el || !el.closest) return null;
        for (const sel of COMPOSE_SELECTORS) {
            const c = el.closest(sel);
            if (c) return c;
        }
        return null;
    }

    /** el が「送信」系ボタン（またはその内部）なら該当ボタン要素を返す */
    function asSendButton(el) {
        if (!el || !el.closest) return null;
        const btn = el.closest('[role="button"]');
        if (!btn) return null;
        const cl = btn.classList;
        if (!cl) return null;
        // aoO=送信 / Uo=送信してアーカイブ。誤爆防止のため T-I（ボタン共通クラス）も要求する
        if ((cl.contains('aoO') || cl.contains('Uo')) && cl.contains('T-I')) return btn;
        // フォールバック: ツールチップの "(Ctrl+Enter)" / "(⌘Enter)" 表記（ロケール非依存）
        const tip = (btn.getAttribute('data-tooltip') || '') + (btn.getAttribute('aria-label') || '');
        if (/(Ctrl|⌘|Cmd)[+＋]?\s*Enter/i.test(tip)) return btn;
        return null;
    }

    /** コンポーズ内の送信ボタンを探す（プログラム的クリック用） */
    function findSendButton(compose) {
        return (
            compose.querySelector('.btC [role="button"].T-I.aoO') ||
            compose.querySelector('[role="button"].T-I.aoO') ||
            [...compose.querySelectorAll('[role="button"]')].find(b => asSendButton(b)) ||
            null
        );
    }

    /** 宛先の収集（チップ UI → 旧 input → 入力途中のテキストの順に統合） */
    function getRecipients(compose, field, diag) {
        const out = [];
        const seen = new Set();
        const push = (email, name, via) => {
            const parsed = RE.parseAddress(email);
            if (!parsed || seen.has(parsed.email)) return;
            seen.add(parsed.email);
            out.push({ email: parsed.email, name: name || parsed.name || '' });
            if (diag) diag.push(`${field}:${via}`);
        };

        // 1) 新 UI のチップ（非表示でも DOM には残る）
        for (const area of compose.querySelectorAll(`div[name="${field}"]`)) {
            for (const chip of area.querySelectorAll('div[data-hovercard-id]')) {
                const email = chip.getAttribute('data-hovercard-id') || '';
                if (email.includes('@')) push(email, chip.getAttribute('data-name') || '', 'chip');
            }
            // 3) チップ化される前の入力途中テキスト（トークン数を上限で制限）
            for (const input of area.querySelectorAll('input[type="text"], textarea')) {
                const v = (input.value || '').trim();
                if (!v) continue;
                for (const part of v.split(/[,;]+/).slice(0, 200)) {
                    if (part.includes('@')) push(part, '', 'typing');
                }
            }
        }

        // 2) 旧 UI の hidden input / さらに古い span[email]
        for (const input of compose.querySelectorAll(`input[name="${field}"]`)) {
            const v = (input.value || '').trim();
            if (v && v !== 'undefined') push(v, '', 'input');
        }

        return out;
    }

    function getSubject(compose) {
        const el = compose.querySelector('input[name="subjectbox"]');
        return el ? (el.value || '') : '';
    }

    /** 本文（引用・署名を除いたテキスト） */
    function getBodyText(compose) {
        const body =
            compose.querySelector('div[role="textbox"][contenteditable="true"]') ||
            compose.querySelector('div[g_editable="true"]') ||
            compose.querySelector('.Am.Al.editable');
        if (!body) return '';
        const clone = body.cloneNode(true);
        for (const q of clone.querySelectorAll('.gmail_quote, blockquote, .gmail_signature')) {
            q.remove();
        }
        // Gmail の本文は「1行目テキスト + <div>行</div>...」構造で、textContent では
        // 改行が消えて全行が連結される（宛名の行頭判定が壊れる）。
        // <br> と ブロック要素の境界を明示的に改行へ変換してから取り出す。
        for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
        for (const block of clone.querySelectorAll('div, p')) block.append('\n');
        return clone.textContent || '';
    }

    function getAttachments(compose) {
        const out = [];
        for (const nameEl of compose.querySelectorAll('.dL .vI')) {
            const size = nameEl.nextElementSibling ? nameEl.nextElementSibling.textContent : '';
            out.push(`${nameEl.textContent || ''}${size || ''}`.trim());
        }
        return out;
    }

    /**
     * 差出人アドレスの推定。優先順:
     *   コンポーズの From 欄 → タブタイトルの「最後の」アドレス →
     *   ヘッダーのアカウントボタン → 直近の成功値（ポップアウト等の保険）
     * タイトルは「件名 - 自分のアドレス - Gmail」形式のため、件名にアドレスが
     * 含まれていても（転送・バウンス・攻撃的な件名）末尾側の自アカウントが勝つ。
     */
    /**
     * タブタイトルからアカウントアドレスを取り出す。
     * Gmail メイン窓のタイトルは「〈件名〉 - account@domain - Gmail」形式で、
     * アカウントは末尾から2番目のダッシュ区画にある。この位置に限定して採ることで、
     * 件名に紛れたアドレス（例: 「Re: 請求 john@acme.com」）を From と誤認しない。
     * ポップアウト窓（件名のみのタイトル）ではこの位置に一致せず '' を返す＝安全側。
     */
    function titleFromEmail(title) {
        const m = String(title || '').match(
            /[-–—]\s*([A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24})\s*[-–—]\s*[^-–—]{1,40}$/);
        return m ? m[1].toLowerCase() : '';
    }

    let cachedFrom = '';
    function getFromEmail(compose) {
        // 1) コンポーズ内の明示的な差出人要素（エイリアス/Send as で切り替えるとここに出る）
        for (const el of compose.querySelectorAll('[name="from"]')) {
            const v = el.value || el.getAttribute('email') || el.textContent || '';
            const p = RE.parseAddress(v);
            if (p) { cachedFrom = p.email; return p.email; }
        }
        const withEmailAttr = compose.querySelector('.az2 [email], [name="from"] [email]');
        if (withEmailAttr) {
            const p = RE.parseAddress(withEmailAttr.getAttribute('email'));
            if (p) { cachedFrom = p.email; return p.email; }
        }
        // 2) タブタイトルの「アカウント位置」に限定して採る（件名アドレスの誤採用を防ぐ）
        const t = titleFromEmail(document.title);
        if (t) { cachedFrom = t; return t; }
        // 3) ヘッダーのアカウントボタン（ポップアウト等でタイトルに載らない場合の保険）
        const acct = document.querySelector('a[aria-label*="@"][href*="SignOut"], a[aria-label*="ccount"][aria-label*="@"], a[aria-label*="@"]');
        if (acct) {
            const p = RE.parseAddress(acct.getAttribute('aria-label'));
            if (p) { cachedFrom = p.email; return p.email; }
        }
        // 取得できないときは '' を返す。呼び出し側は自社ドメイン除外を無効化する＝
        // 「内部だから素通し」を誤って行わない安全側に倒れる。
        return cachedFrom;
    }

    /**
     * 返信中のスレッドの参加者（各メッセージヘッダの差出人・宛先）。
     * これにより、拡張導入後にそのスレッドで送信したことがなくても
     * 「このスレッドに居ない宛先の紛れ込み」を初回返信から検知できる。
     * スレッドビュー内のインライン返信のときのみ収集する
     * （新規作成ポップアップはスレッドと無関係のため空を返す）。
     * `.gE` はメッセージヘッダの要素で、作成中コンポーズのチップは含まれない（実機確認済み）。
     */
    function getThreadParticipants(compose) {
        if (!compose.closest('div[role="main"]')) return [];
        const out = new Set();
        for (const s of document.querySelectorAll('div[role="main"] .gE span[email]')) {
            const e = (s.getAttribute('email') || '').toLowerCase();
            if (e.includes('@')) out.add(e);
        }
        return [...out];
    }

    /** コンポーズから送信内容一式を読み取る */
    function readMail(compose) {
        const diag = [];
        const mail = {
            to: getRecipients(compose, 'to', diag),
            cc: getRecipients(compose, 'cc', diag),
            bcc: getRecipients(compose, 'bcc', diag),
            subject: getSubject(compose),
            bodyText: getBodyText(compose),
            attachments: getAttachments(compose),
            fromEmail: getFromEmail(compose),
            threadParticipants: getThreadParticipants(compose)
        };
        mail.diag = diag;
        return mail;
    }

    root.PSG_GmailDom = {
        findCompose, asSendButton, findSendButton, readMail,
        COMPOSE_SELECTORS
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
