/* help.js — 仕様ページの付録をコード（PSG_RiskEngine の公開定数）から描画する。
   一覧を手書きしないことで、仕様書と実装の乖離を防ぐ。 */
(function () {
    'use strict';
    const RE = globalThis.PSG_RiskEngine;

    function chips(id, items) {
        const box = document.getElementById(id);
        for (const item of items) {
            const s = document.createElement('span');
            s.textContent = item;
            box.appendChild(s);
        }
    }

    // 付録A: 主要ドメイン
    chips('list-domains', RE.COMMON_DOMAINS);

    // 付録B: 姓ローマ字辞書
    const surnames = Object.keys(RE.SURNAME_ROMAJI);
    document.getElementById('surname-count').textContent =
        `収録: ${surnames.length} 姓（あいうえお順ではなく一般的な多い姓の順）`;
    const dict = document.getElementById('list-surnames');
    for (const kanji of surnames) {
        const div = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = kanji;
        const span = document.createElement('span');
        span.textContent = ' ' + RE.SURNAME_ROMAJI[kanji].join(' / ');
        div.appendChild(b);
        div.appendChild(span);
        dict.appendChild(div);
    }

    // 付録C: 異体字
    chips('list-kanji', Object.entries(RE.KANJI_VARIANTS).map(([from, to]) => `${from} → ${to}`));

    // 付録D: 敬称・除外語・件名接頭辞
    chips('list-honorifics', RE.HONORIFICS);
    chips('list-block-ja', RE.GREETING_BLOCK_WORDS);
    chips('list-block-en', RE.EN_GREETING_BLOCK_WORDS);
    chips('list-prefixes', RE.SUBJECT_PREFIXES.concat(['：', ':']));
})();
