/**
 * risk-engine.js — 送信内容の危険度を判定する純粋ロジック。
 * DOM・chrome API に依存しないため、Node の単体テストでそのまま検証できる。
 *
 * 設計方針:
 *   毎回同じ確認を強制すると人は読まなくなる（確認の形骸化）。
 *   そこで「既知で安全な送信は素通し、異常があるときだけ、その異常だけを確認させる」。
 *   各異常は一度確認すると履歴に学習され、次回からは出ない（自己沈静化）。
 */
(function (root) {
    'use strict';

    /** よく使われるフリーメール/キャリアドメイン。typo 判定の照合先にも使う。
     *  日本のキャリア/ISP に加え、世界の主要プロバイダも含める（誰でも使えるように）。 */
    const COMMON_DOMAINS = [
        // グローバル大手
        'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
        'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
        'protonmail.com', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com',
        'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
        'naver.com', 'daum.net', 'hanmail.net', 'seznam.cz', 'orange.fr', 'free.fr',
        'libero.it', 'comcast.net', 'verizon.net', 'sbcglobal.net', 'btinternet.com',
        // 日本のフリーメール/キャリア/ISP
        'yahoo.co.jp', 'outlook.jp', 'hotmail.co.jp', 'docomo.ne.jp', 'ezweb.ne.jp',
        'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'ymobile.ne.jp', 'nifty.com',
        'biglobe.ne.jp', 'so-net.ne.jp', 'ocn.ne.jp', 'nifty.ne.jp', 'excite.co.jp'
    ];

    /** 共有ドメイン。ここに該当する From は「自社ドメイン」扱いしない */
    const FREEMAIL = new Set(COMMON_DOMAINS);

    // 注: Gmail 本体が持つ機能（添付忘れ検出・宛先ゼロのブロック・アップロード中の
    // 送信ブロック）は実装しない。この拡張は「宛先の取り違え・漏洩」だけに集中する。

    const DEFAULT_SETTINGS = {
        checkFirstRecipient: true,   // 初めての宛先を確認する
        checkLookalike: true,        // 似たアドレス/ドメインとの取り違えを警告する
        checkNewCombo: true,         // 初めての「組織の組み合わせ」を警告する
        checkManyVisible: true,      // To/Cc の外部宛先が多いとき BCC を提案する
        manyVisibleThreshold: 5,
        checkKnownLookalike: true,   // 既知同士の取り違え（普段の宛先と酷似）を一度だけ確認する
        checkGreeting: true,         // 本文の宛名（〇〇様）と宛先の不一致を警告する
        checkThreadDelta: true,      // 同じ件名の過去送信に居なかった宛先を警告する
        checkSkipInternal: true,     // 自社ドメイン宛はチェックしない（フリーメールの From では無効）
        strictMode: false,           // 常に確認ダイアログを出す（従来型の動作）
        learnEnabled: true,
        syncEnabled: true,           // 学習データを端末間で同期する（Chrome の同期を利用）
        showToast: true              // 正常送信時のさりげない通知（トースト）を表示する
    };

    /** 異体字の正規化（宛名照合用） */
    const KANJI_VARIANTS = {
        '齋': '斉', '齊': '斉', '斎': '斉', '髙': '高', '﨑': '崎', '邊': '辺',
        '邉': '辺', '澤': '沢', '濱': '浜', '國': '国', '眞': '真', '壽': '寿',
        '惠': '恵', '廣': '広', '嶋': '島', '冨': '富', '萬': '万', '與': '与',
        '瀨': '瀬', '龜': '亀', '槇': '槙', '藪': '薮', '淺': '浅'
    };

    /** 宛名として扱わない語（慣用句・総称・社名接尾語）。仕様ページにも表示される */
    const GREETING_BLOCK_WORDS = [
        '疲れ', '苦労', '世話', '客', '皆', '各位', '担当', '関係',
        '会社', '法人', '組合', '協会', '銀行', '大学', '病院', '部門',
        'チーム', 'グループ', '御中',
        '商事', '物産', '工業', '建設', '産業', '興業', '電機', '電工',
        '運輸', '通商', '商会', '製作所', '不動産', '証券', '保険',
        '株式', '有限', '合同'
    ];
    const GREETING_BLOCKLIST = new RegExp('(' + GREETING_BLOCK_WORDS.join('|') + ')');

    /** 英語の集合宛名（Dear all 等）。個人名ではないので照合対象にしない */
    const EN_GREETING_BLOCK_WORDS = [
        'all', 'team', 'both', 'everyone', 'colleagues', 'folks',
        'sir', 'sirs', 'madam', 'customer', 'customers', 'support',
        'sales', 'hiring', 'there', 'friend', 'friends'
    ];
    const EN_GREETING_BLOCKLIST = new RegExp('^(' + EN_GREETING_BLOCK_WORDS.join('|') + ')$');

    /** 宛名とみなす敬称・役職。仕様ページにも表示される */
    const HONORIFICS = [
        '様', 'さま', '殿', '先生', '教授',
        '部長', '課長', '係長', '次長', '専務', '常務', '社長', '会長', '主任', '所長',
        'さん'
    ];

    /** 件名の比較時に除去する接頭辞 */
    const SUBJECT_PREFIXES = ['re', 'fw', 'fwd', '返信', '転送', '回答'];

    /**
     * 代表的な姓 → ローマ字表記（ヘボン式ゆれ含む）。
     * 表示名が無い宛先でも、メールアドレスのローカル部と宛名を照合するために使う。
     */
    const SURNAME_ROMAJI = {
        '佐藤': ['sato', 'satou', 'satoh'], '鈴木': ['suzuki'], '高橋': ['takahashi'],
        '田中': ['tanaka'], '伊藤': ['ito', 'itou', 'itoh'], '伊東': ['ito', 'itou', 'itoh'],
        '渡辺': ['watanabe', 'watabe'], '山本': ['yamamoto'], '中村': ['nakamura'],
        '小林': ['kobayashi'], '加藤': ['kato', 'katou', 'katoh'], '吉田': ['yoshida'],
        '山田': ['yamada'], '佐々木': ['sasaki'], '山口': ['yamaguchi'], '松本': ['matsumoto'],
        '井上': ['inoue'], '木村': ['kimura'], '林': ['hayashi'], '斉藤': ['saito', 'saitou', 'saitoh'],
        '清水': ['shimizu'], '山崎': ['yamazaki', 'yamasaki'], '森': ['mori'], '阿部': ['abe'],
        '池田': ['ikeda'], '橋本': ['hashimoto'], '山下': ['yamashita'], '石川': ['ishikawa'],
        '中島': ['nakajima', 'nakashima'], '前田': ['maeda'], '藤田': ['fujita'],
        '後藤': ['goto', 'gotou', 'gotoh'], '小川': ['ogawa'], '岡田': ['okada'],
        '村上': ['murakami'], '長谷川': ['hasegawa'], '近藤': ['kondo', 'kondou', 'kondoh'],
        '石井': ['ishii'], '遠藤': ['endo', 'endou', 'endoh'], '坂本': ['sakamoto'],
        '青木': ['aoki'], '藤井': ['fujii'], '西村': ['nishimura'], '福田': ['fukuda'],
        '太田': ['ota', 'oota', 'ohta'], '三浦': ['miura'], '藤原': ['fujiwara'],
        '岡本': ['okamoto'], '松田': ['matsuda'], '中川': ['nakagawa'], '中野': ['nakano'],
        '原田': ['harada'], '小野': ['ono'], '田村': ['tamura'], '竹内': ['takeuchi'],
        '金子': ['kaneko'], '和田': ['wada'], '中山': ['nakayama'], '石田': ['ishida'],
        '上田': ['ueda'], '森田': ['morita'], '柴田': ['shibata'], '原': ['hara'],
        '宮崎': ['miyazaki'], '酒井': ['sakai'], '工藤': ['kudo', 'kudou', 'kudoh'],
        '横山': ['yokoyama'], '宮本': ['miyamoto'], '内田': ['uchida'], '高木': ['takagi', 'takaki'],
        '安藤': ['ando', 'andou', 'andoh'], '島田': ['shimada'], '谷口': ['taniguchi'],
        '大野': ['ono', 'oono', 'ohno'], '高田': ['takada', 'takata'], '丸山': ['maruyama'],
        '今井': ['imai'], '河野': ['kono', 'kouno', 'kawano'], '藤本': ['fujimoto'],
        '村田': ['murata'], '武田': ['takeda'], '上野': ['ueno'], '杉山': ['sugiyama'],
        '増田': ['masuda'], '小島': ['kojima'], '大塚': ['otsuka', 'ootsuka', 'ohtsuka'],
        '平野': ['hirano'], '菅原': ['sugawara'], '久保': ['kubo'], '松井': ['matsui'],
        '千葉': ['chiba'], '岩崎': ['iwasaki'], '桜井': ['sakurai'], '木下': ['kinoshita'],
        '野口': ['noguchi'], '松尾': ['matsuo'], '菊地': ['kikuchi'], '菊池': ['kikuchi'],
        '野村': ['nomura'], '新井': ['arai'], '渡部': ['watanabe', 'watabe'], '佐野': ['sano'],
        '大西': ['onishi', 'oonishi', 'ohnishi'], '杉本': ['sugimoto'], '浜田': ['hamada'],
        '市川': ['ichikawa'], '水野': ['mizuno'], '小松': ['komatsu'], '高山': ['takayama'],
        '西田': ['nishida'], '菅野': ['kanno', 'sugano'], '大久保': ['okubo', 'ookubo', 'ohkubo'],
        '松岡': ['matsuoka'], '吉川': ['yoshikawa', 'kikkawa'], '山内': ['yamauchi'],
        '西川': ['nishikawa'], '五十嵐': ['igarashi'], '北村': ['kitamura'], '安田': ['yasuda'],
        '中田': ['nakata', 'nakada'], '川口': ['kawaguchi'], '平田': ['hirata'],
        '川崎': ['kawasaki'], '飯田': ['iida'], '吉村': ['yoshimura'], '川上': ['kawakami'],
        '本田': ['honda'], '久保田': ['kubota'], '沢田': ['sawada'], '辻': ['tsuji'],
        '関': ['seki'], '吉岡': ['yoshioka'], '岩田': ['iwata'], '中西': ['nakanishi'],
        '服部': ['hattori'], '樋口': ['higuchi'], '福島': ['fukushima'], '川島': ['kawashima'],
        '永井': ['nagai'], '松下': ['matsushita'], '田口': ['taguchi'], '山中': ['yamanaka'],
        '森本': ['morimoto'], '土屋': ['tsuchiya'], '矢野': ['yano'], '広瀬': ['hirose'],
        '秋山': ['akiyama'], '石原': ['ishihara'], '松浦': ['matsuura'], '小池': ['koike'],
        '馬場': ['baba'], '大石': ['oishi', 'ooishi', 'ohishi'], '松原': ['matsubara'],
        '大橋': ['ohashi', 'oohashi'], '松永': ['matsunaga'], '吉野': ['yoshino'],
        '大谷': ['otani', 'ootani', 'ohtani'], '内藤': ['naito', 'naitou', 'naitoh'],
        '黒田': ['kuroda'], '尾崎': ['ozaki'], '永田': ['nagata'], '熊谷': ['kumagai', 'kumagaya'],
        '篠原': ['shinohara'], '西山': ['nishiyama'], '岡崎': ['okazaki'], '小山': ['koyama', 'oyama']
    };

    /* ------------------------------------------------------------------ */
    /* 基本ユーティリティ                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * '"山田 太郎" <taro@example.co.jp>' / 'taro@example.co.jp' 等をパースする。
     * @returns {{email:string, name:string}|null}
     */
    function parseAddress(raw) {
        if (!raw) return null;
        let s = String(raw).trim();
        if (!s) return null;
        // ReDoS ガード: 有効なメールアドレスは最大254字。長い入力は切り詰める。
        // これと下の有界量指定子で、悪意ある長大文字列でも線形時間に抑える。
        if (s.length > 320) s = s.slice(0, 320);
        let name = '';
        const angled = s.match(/^([^<>]{0,320}?)<\s{0,64}([^<>]{1,320}?)\s{0,64}>\s{0,64}$/);
        if (angled) {
            name = angled[1].replace(/^["'\s]+|["'\s]+$/g, '');
            s = angled[2].trim();
        }
        const m = s.match(/[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/);
        if (!m) return null;
        return { email: m[0].toLowerCase(), name };
    }

    /**
     * テキスト中の「最後の」メールアドレスを返す。
     * Gmail のタブタイトルは「件名 - 自分のアドレス - Gmail」の形式で、件名に
     * アドレスが含まれる（転送・バウンス通知等）と先頭一致では件名側を拾ってしまう。
     * 自アカウントは常に末尾側にあるため、末尾320字から最後の一致を採用する。
     */
    function lastEmailIn(text) {
        const tail = String(text || '').slice(-320);
        const all = tail.match(/[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g);
        return all && all.length ? all[all.length - 1].toLowerCase() : '';
    }

    function domainOf(email) {
        const at = email.lastIndexOf('@');
        return at === -1 ? '' : email.slice(at + 1).toLowerCase();
    }

    function localPartOf(email) {
        const at = email.lastIndexOf('@');
        return at === -1 ? email : email.slice(0, at).toLowerCase();
    }

    /**
     * 編集距離（上限 max で打ち切り）。typo・取り違え検出に使う。
     */
    function levenshtein(a, b, max) {
        if (a === b) return 0;
        const la = a.length, lb = b.length;
        if (Math.abs(la - lb) > max) return max + 1;
        let prev = new Array(lb + 1);
        let cur = new Array(lb + 1);
        for (let j = 0; j <= lb; j++) prev[j] = j;
        for (let i = 1; i <= la; i++) {
            cur[0] = i;
            let rowMin = i;
            const ca = a.charCodeAt(i - 1);
            for (let j = 1; j <= lb; j++) {
                const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
                if (cur[j] < rowMin) rowMin = cur[j];
            }
            if (rowMin > max) return max + 1;
            [prev, cur] = [cur, prev];
        }
        return prev[lb];
    }

    /** 外部ドメイン同士の組み合わせを表すキー（順序に依存しない） */
    function comboKey(domains) {
        return domains.slice().sort().join('|');
    }

    /** 宛名照合用の正規化（異体字統一・空白除去・小文字化） */
    function normalizeJaName(s) {
        if (!s) return '';
        let out = '';
        for (const ch of String(s)) out += KANJI_VARIANTS[ch] || ch;
        return out.replace(/[\s　]+/g, '').toLowerCase();
    }

    /**
     * 本文冒頭から宛名（「〇〇様」「〇〇さん」「Dear X」等）を抽出する。
     *
     * 誤検知対策（敵対的レビューで確認された事例に基づく）:
     *   - 行頭に現れる宛名のみ採用（「先日と同様に」「仕様書」等の文中複合語を構造的に排除）
     *   - 敬称の直後が行末・読点・空白・「へ」の場合のみ宛名とみなす
     *     （「鈴木様よりご紹介」「佐藤様におかれましては」等の文中言及を排除）
     *   - カタカナのみの宛名（社名が多く、照合手段が無い）は判定不能として除外
     * @returns {Array<string>} 正規化済みの宛名候補
     */
    function extractGreetings(bodyText) {
        const head = String(bodyText || '').slice(0, 300);
        const lines = head.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean).slice(0, 5);
        const out = [];
        const push = (name) => {
            const n = normalizeJaName(name);
            if (!n || n.length > 10) return;
            if (GREETING_BLOCKLIST.test(n)) return;
            if (/^[ァ-ヴー]+$/.test(name)) return; // カタカナのみ（社名等）は照合不能
            if (!out.includes(n)) out.push(n);
        };
        const ja = new RegExp(
            '^([一-龯々ヶァ-ヴーA-Za-z]{1,8}?)[\\s　]*(?:' + HONORIFICS.join('|') + ')' +
            '(?=$|[\\s　、。，,．・：:；;／/（(]|へ$)'
        );
        const en = /^dear\s+(?:(?:mr|ms|mrs|dr|prof|professor)\.?\s+)?([a-z][a-z-]{1,20})/i;
        for (const line of lines) {
            // 「佐藤様、田中様」のような連名にも対応
            for (const part of line.split(/[、,・]+/).map(s => s.trim()).filter(Boolean)) {
                const m = part.match(ja);
                if (m) push(m[1]);
            }
            const em = line.match(en);
            if (em && !EN_GREETING_BLOCKLIST.test(em[1].toLowerCase())) push(em[1]);
        }
        return out;
    }

    /** ローマ字トークン照合: セグメント完全一致 or 前方一致のみ（'saito' に 'ito' を誤一致させない） */
    function romajiHits(segments, r) {
        return segments.some(seg => seg === r || seg.startsWith(r));
    }

    /** 宛名が宛先（表示名・アドレス・ドメイン）に一致するか */
    function greetingMatchesRecipient(greet, recipient) {
        const g = normalizeJaName(greet);
        if (!g) return true; // 判定不能は一致扱い（誤検知させない）
        const name = normalizeJaName(recipient.name || '');
        if (name && (name.includes(g) || g.includes(name))) return true;
        // 照合用トークン: ローカル部のセグメント / 表示名の単語 / ドメイン（記号除去）
        const lpSegs = localPartOf(recipient.email).split(/[^a-z]+/).filter(Boolean);
        const nameTokens = String(recipient.name || '').toLowerCase().split(/[\s　.,、]+/).filter(Boolean);
        const domainFlat = domainOf(recipient.email).replace(/[^a-z]/g, '');
        const __matchRomaji = (r) =>
            romajiHits(lpSegs, r) || romajiHits(nameTokens, r) || (r.length >= 3 && domainFlat.includes(r));
        // ローマ字宛名（Dear Sato / ローマ字表示名）
        if (/^[a-z-]+$/.test(g) && __matchRomaji(g.replace(/-/g, ''))) return true;
        // 漢字姓 → ローマ字でローカル部/表示名/ドメインと照合
        // （フルネーム宛名「斉藤太郎」にも対応するため先頭2〜3文字も試す）
        const candidates = [g, g.slice(0, 3), g.slice(0, 2)].filter(x => x.length >= 1);
        for (const c of candidates) {
            const romaji = SURNAME_ROMAJI_NORM[c];
            if (!romaji) continue;
            for (const r of romaji) {
                if (__matchRomaji(r)) return true;
            }
        }
        return false;
    }
    // SURNAME_ROMAJI を正規化キーで引けるように（齋藤/斎藤→斉藤 等）
    const SURNAME_ROMAJI_NORM = {};
    for (const k of Object.keys(SURNAME_ROMAJI)) {
        SURNAME_ROMAJI_NORM[normalizeJaName(k)] = SURNAME_ROMAJI[k];
    }

    /**
     * 宛名と宛先が「一致はしないが紛らわしい」か（打ち間違い・取り違えの根拠）。
     * 例: 宛名「斉藤」(saito) と sato@… / 表示名「佐藤」。
     * 宛名警告はこの根拠があるときだけ出す（照合材料ゼロの宛先では鳴らさない）。
     */
    function greetingLookalike(greet, recipient) {
        const g = normalizeJaName(greet);
        if (!g) return false;
        const isLatin = /^[a-z-]+$/.test(g);
        // 宛名のローマ字候補
        const variants = [];
        if (isLatin) variants.push(g.replace(/-/g, ''));
        for (const c of [g, g.slice(0, 3), g.slice(0, 2)]) {
            const r = SURNAME_ROMAJI_NORM[c];
            if (r) { variants.push(...r); break; }
        }
        // 宛先側のトークン（ローカル部セグメント + 表示名の単語）
        const segs = localPartOf(recipient.email).split(/[^a-z]+/).filter(Boolean)
            .concat(String(recipient.name || '').toLowerCase().split(/[\s　.,、]+/).filter(Boolean));
        for (const v of variants) {
            for (const seg of segs) {
                if (seg.length < 3) continue;
                const max = Math.max(seg.length, v.length) >= 6 ? 2 : 1;
                if (levenshtein(seg, v, 2) <= max) return true;
            }
        }
        // 漢字表示名どうしの近さ（佐藤 ↔ 斉藤 など一字違いの姓）
        if (!isLatin) {
            const name = normalizeJaName(recipient.name || '');
            if (name && g.length >= 2 && levenshtein(g, name.slice(0, g.length), 1) <= 1) {
                return true;
            }
        }
        return false;
    }

    /**
     * 件名からスレッドキーを作る。Re:/Fwd: 等の接頭辞を除去し、短すぎる件名は対象外。
     * 件名そのものは保存せずハッシュのみ保存する。
     */
    function subjectKey(subject) {
        let s = String(subject || '').trim().toLowerCase();
        const prefixRe = new RegExp('^(?:' + SUBJECT_PREFIXES.join('|') + ')[:：]\\s*', 'i');
        let prev = null;
        while (prev !== s) {
            prev = s;
            s = s.replace(prefixRe, '').trim();
        }
        s = s.replace(/[\s　]+/g, '');
        if (s.length < 4) return null;
        // djb2
        let h = 5381;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        }
        return 't' + (h >>> 0).toString(36);
    }

    /* ------------------------------------------------------------------ */
    /* 判定本体                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * @param mail {{
     *   to:      Array<{email:string,name:string}>,
     *   cc:      Array<{email:string,name:string}>,
     *   bcc:     Array<{email:string,name:string}>,
     *   subject: string,
     *   bodyText:string,           // 引用部を除いた本文テキスト
     *   attachments: Array<string>,// 添付ファイル名
     *   fromEmail: string          // 取得できなければ ''
     * }}
     * @param history {{recipients:Object, domains:Object, combos:Object}}
     * @param settings
     * @returns {{anomalies:Array, learn:Object, recipients:Array}}
     *   anomalies: [{type, params, rows?}] — UI が i18n して表示する
     *   learn:     送信確定時に履歴へ書き込むべき内容
     */
    function analyze(mail, history, settings) {
        const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
        const hist = history || {};
        const knownRecipients = hist.recipients || {};
        const knownDomains = hist.domains || {};
        const knownCombos = hist.combos || {};
        const pairAcks = hist.pairAcks || {};
        const greetAcks = hist.greetAcks || {};
        const threads = hist.threads || {};

        const anomalies = [];

        // 全宛先（重複除去済み）
        const seen = new Set();
        const all = [];
        for (const field of ['to', 'cc', 'bcc']) {
            for (const r of (mail[field] || [])) {
                if (!r || !r.email || seen.has(r.email)) continue;
                seen.add(r.email);
                all.push({ email: r.email, name: r.name || '', field, domain: domainOf(r.email) });
            }
        }

        const fromDomain = mail.fromEmail ? domainOf(mail.fromEmail) : '';
        // 「自組織ドメイン」: From のドメイン。ただしフリーメール（gmail.com 等）は
        // 同一ドメイン＝同一組織ではないため、自組織なしとして扱う。
        // （これを外部判定に使わないと、gmail アカウントから gmail 宛の一斉送信で
        //   全員が「内部」扱いになり BCC 提案が出ない）
        const orgDomain = FREEMAIL.has(fromDomain) ? '' : fromDomain;
        const isExternal = (d) => d && d !== orgDomain;

        // 自社ドメイン宛の除外: From が自組織ドメインのとき、同僚宛はチェックしない
        const internalExempt = cfg.checkSkipInternal && !!orgDomain;
        const isInternalR = (r) => internalExempt && r.domain === orgDomain;
        const allInternal = internalExempt && all.length > 0 && all.every(isInternalR);

        /* --- 宛先ゼロは Gmail 自身がブロックするため素通し ----------- */
        if (all.length === 0) {
            return { anomalies: [], learn: null, recipients: all, passThrough: true };
        }

        /* --- 初めての宛先・取り違え・typo ---------------------------- */
        const knownEmailList = Object.keys(knownRecipients);
        // 類似照合の前計算。levenshtein(max=2) は長さ差が2を超えると一致し得ないため、
        // ローカル部・全体の長さ差で足切りしてから距離計算する。
        // （履歴3000件×宛先多数のとき、送信クリックの同期ブロックを数百ms→数msに抑える）
        const knownMeta = knownEmailList.map(e => ({ e, lp: localPartOf(e), d: domainOf(e) }));
        const similarKnown = (rEmail, rLp, rDomain) => {
            const hits = [];
            for (const m of knownMeta) {
                if (m.e === rEmail) continue;
                if (Math.abs(rLp.length - m.lp.length) > 2 &&
                    Math.abs(rEmail.length - m.e.length) > 2) continue; // 足切り
                let simi = false;
                if (m.d === rDomain && rLp.length >= 3) {
                    simi = levenshtein(rLp, m.lp, 2) <= (rLp.length >= 6 ? 2 : 1);
                } else if (rEmail.length >= 8) {
                    simi = levenshtein(rEmail, m.e, 2) <= 2;
                }
                if (simi) hits.push(m.e);
            }
            return hits;
        };
        const firstTimers = [];
        for (const r of all) {
            if (knownRecipients[r.email]) continue;
            if (isInternalR(r)) continue; // 同僚宛は確認不要
            const row = { email: r.email, name: r.name, field: r.field, notes: [] };

            const domainKnown = !!knownDomains[r.domain];
            if (!domainKnown && isExternal(r.domain)) {
                row.notes.push({ type: 'new_domain', params: [r.domain] });

                // ドメイン typo 疑い: 既知/有名ドメインに酷似
                if (cfg.checkLookalike) {
                    const candidates = Object.keys(knownDomains).concat(COMMON_DOMAINS);
                    let best = null;
                    for (const d of candidates) {
                        if (d === r.domain) { best = null; break; }
                        const dist = levenshtein(r.domain, d, 2);
                        if (dist > 0 && dist <= 2 && (!best || dist < best.dist)) {
                            best = { d, dist };
                        }
                    }
                    if (best) {
                        row.notes.push({ type: 'lookalike_domain', params: [best.d] });
                    }
                }
            }

            // アドレス取り違え疑い: 既知の別アドレスに酷似（同姓・一文字違い等）
            if (cfg.checkLookalike) {
                const hits = similarKnown(r.email, localPartOf(r.email), r.domain);
                if (hits.length > 0) {
                    row.notes.push({ type: 'lookalike_recipient', params: [hits[0]] });
                }
            }
            firstTimers.push(row);
        }
        if (cfg.checkFirstRecipient && firstTimers.length > 0) {
            anomalies.push({ type: 'first_recipients', params: [String(firstTimers.length)], rows: firstTimers });
        }

        /* --- 初めての組織の組み合わせ（別組織への同時送信） ---------- */
        // フリーメールのドメインは「組織」ではないため組み合わせ判定から除く
        const externalDomains = [...new Set(
            all.filter(r => r.field !== 'bcc' && isExternal(r.domain) && !FREEMAIL.has(r.domain))
               .map(r => r.domain)
        )];
        let comboToLearn = null;
        if (externalDomains.length >= 2) {
            const key = comboKey(externalDomains);
            comboToLearn = key;
            if (cfg.checkNewCombo && !knownCombos[key]) {
                // 部分集合が既知でも、新しい組み合わせなら警告する
                anomalies.push({ type: 'new_combo', params: [externalDomains.join('  +  ')] });
            }
        }

        /* --- To/Cc に外部宛先が多い（BCC 推奨） ---------------------- */
        if (cfg.checkManyVisible) {
            const visibleExternal = all.filter(r => r.field !== 'bcc' && isExternal(r.domain));
            if (visibleExternal.length >= cfg.manyVisibleThreshold) {
                anomalies.push({ type: 'many_visible', params: [String(visibleExternal.length)] });
            }
        }

        /* --- 既知同士の取り違え（普段の宛先と酷似した別アドレス） ---- */
        // 「前に送ったことがある宛先」は素通りするため、既知でも
        // 「よく送る宛先と紛らわしく、かつ普段ほとんど送らない」場合は一度だけ確認する。
        const pairAcksToLearn = [];
        if (cfg.checkKnownLookalike) {
            const rows = [];
            for (const r of all) {
                const rInfo = knownRecipients[r.email];
                if (!rInfo) continue; // 初見の宛先は first_recipients 側で扱う
                if (isInternalR(r)) continue; // 同僚宛は確認不要
                let best = null;
                const matchedKeys = []; // 類似する全ペア。1回の確認で全て沈静化させる
                for (const known of similarKnown(r.email, localPartOf(r.email), r.domain)) {
                    if (seen.has(known)) continue; // 同時送信中の相手は除外
                    const kInfo = knownRecipients[known];
                    // 「普段の宛先」条件: 十分な送信実績があり、今回の宛先より明確に多い
                    if (!kInfo || kInfo.c < 3 || kInfo.c < rInfo.c * 2) continue;
                    const key = [r.email, known].sort().join('|');
                    if (pairAcks[key]) continue; // 既に「別人」と確認済み
                    matchedKeys.push(key);
                    if (!best || kInfo.c > best.count) {
                        best = { known, count: kInfo.c };
                    }
                }
                if (best) {
                    rows.push({
                        email: r.email, name: r.name, field: r.field,
                        notes: [{ type: 'known_lookalike', params: [best.known, String(best.count), String(rInfo.c)] }]
                    });
                    pairAcksToLearn.push(...matchedKeys);
                }
            }
            if (rows.length > 0) {
                anomalies.push({ type: 'known_lookalike', params: [String(rows.length)], rows });
            }
        }

        /* --- 本文の宛名（〇〇様）と宛先の不一致 ---------------------- */
        const greetAcksToLearn = [];
        if (cfg.checkGreeting && all.length > 0 && !allInternal) {
            const greetings = extractGreetings(mail.bodyText);
            // 抽出した宛名のどれかが現在の宛先に一致するなら、このメールは正しく宛名
            // されているとみなし、残りの名前（紹介者・関係者への言及）では警告しない
            const anyMatch = greetings.some(g => all.some(r => greetingMatchesRecipient(g, r)));
            if (greetings.length > 0 && !anyMatch) {
                for (const g of greetings) {
                    const ackKeys = all.map(r => g + '|' + r.email);
                    if (ackKeys.some(k => greetAcks[k])) continue; // この宛名+宛先は確認済み
                    // 宛名に一致する既知の宛先（＝本来の相手候補）を探す。
                    // 表示名の一致を送信回数より優先する（部分文字列一致の誤提案を防ぐ）
                    let suggest = null;
                    for (const known of knownEmailList) {
                        if (seen.has(known)) continue;
                        const kInfo = knownRecipients[known];
                        const cand = { email: known, name: (kInfo && kInfo.n) || '' };
                        if (greetingMatchesRecipient(g, cand)) {
                            const nameExact = kInfo && kInfo.n &&
                                normalizeJaName(kInfo.n).includes(normalizeJaName(g));
                            const score = (nameExact ? 1e9 : 0) + ((kInfo && kInfo.c) || 0);
                            if (!suggest || score > suggest.score) suggest = { email: known, score };
                        }
                    }
                    // 発火条件: 「疑いの根拠」があるときだけ出す。
                    //   (1) 宛名に一致する過去の宛先がいる → 宛先の選び間違いの疑い（suggest）
                    //   (2) 宛先の中に宛名と紛らわしい相手がいる → 打ち間違いの疑い
                    // 根拠ゼロ（趣味アドレス・共有窓口など照合材料が無いだけ）の場合は黙る
                    const lookalike = all.find(r => greetingLookalike(g, r));
                    if (!suggest && !lookalike) continue;
                    if (suggest) {
                        anomalies.push({ type: 'greeting_mismatch_suggest', params: [g, suggest.email] });
                    } else {
                        anomalies.push({ type: 'greeting_mismatch', params: [g, lookalike.email] });
                    }
                    greetAcksToLearn.push(...ackKeys);
                    break; // 宛名の警告は1通につき1件まで（多重警告を避ける）
                }
            }
        }

        /* --- スレッドに居なかった宛先 -------------------------------- */
        // メンバーの情報源は2つ:
        //   (1) 同じ件名で過去に送信したときの学習履歴
        //   (2) いま返信しているスレッドの参加者（画面から取得。履歴ゼロの初回返信でも効く）
        // 転送（Fwd:）は「スレッド外の相手に送る」操作そのものなので (2) は使わない
        const threadKey = subjectKey(mail.subject);
        if (cfg.checkThreadDelta) {
            const isForward = /^\s*(?:fwd?|転送)[:：]/i.test(String(mail.subject || ''));
            const members = new Set(
                (threadKey && threads[threadKey] && threads[threadKey].r) || []);
            if (!isForward) {
                for (const p of (mail.threadParticipants || [])) members.add(p);
            }
            if (members.size > 0) {
                const newcomers = all.filter(r => !members.has(r.email));
                // 「全員入れ替え（定型件名の別件）は黙る」判定は外部宛先のみで行う。
                // 上司などの内部CCが常連だと、定型件名の新規案件が毎回「スレッド継続」に
                // 誤判定されるため（敵対的レビューで確認された誤検知）
                const extAll = all.filter(r => isExternal(r.domain));
                let fireRows = [];
                if (extAll.length > 0) {
                    const extNew = newcomers.filter(r => isExternal(r.domain));
                    if (extNew.length > 0 && extNew.length < extAll.length) fireRows = extNew;
                } else if (!internalExempt && newcomers.length > 0 && newcomers.length < all.length) {
                    fireRows = newcomers; // 内部のみのメールは従来判定（自社除外オフ時のみ）
                }
                if (fireRows.length > 0) {
                    anomalies.push({
                        type: 'thread_new',
                        params: [String(fireRows.length)],
                        rows: fireRows.map(r => ({ email: r.email, name: r.name, field: r.field, notes: [] }))
                    });
                }
            }
        }

        /* --- 学習内容 ------------------------------------------------ */
        const learn = {
            recipients: all.map(r => ({ email: r.email, name: r.name })),
            domains: [...new Set(all.map(r => r.domain).filter(Boolean))],
            combo: comboToLearn,
            pairAcks: pairAcksToLearn,
            greetAcks: greetAcksToLearn,
            threadKey,
            threadRecipients: all.map(r => r.email)
        };

        return { anomalies, learn, recipients: all };
    }

    /** 発生しうる異常タイプの一覧。UI 文言の網羅テストで使用する */
    const ANOMALY_TYPES = [
        'first_recipients', 'known_lookalike',
        'greeting_mismatch', 'greeting_mismatch_suggest',
        'thread_new', 'new_combo', 'many_visible',
        'read_failed' // content.js のフェイルセーフで使用
    ];
    /** 宛先行に付く注記タイプの一覧 */
    const NOTE_TYPES = ['new_domain', 'lookalike_domain', 'lookalike_recipient', 'known_lookalike'];

    const RiskEngine = {
        parseAddress, lastEmailIn, domainOf, localPartOf, levenshtein, comboKey, analyze,
        normalizeJaName, extractGreetings, greetingMatchesRecipient, subjectKey,
        DEFAULT_SETTINGS, COMMON_DOMAINS, ANOMALY_TYPES, NOTE_TYPES,
        // 仕様ページ（help/）がコードから直接描画するための公開定数
        SURNAME_ROMAJI, KANJI_VARIANTS, HONORIFICS, SUBJECT_PREFIXES,
        GREETING_BLOCK_WORDS, EN_GREETING_BLOCK_WORDS
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = RiskEngine; // Node (単体テスト)
    }
    root.PSG_RiskEngine = RiskEngine; // ブラウザ (content script)
})(typeof globalThis !== 'undefined' ? globalThis : this);
