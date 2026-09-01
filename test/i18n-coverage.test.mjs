/**
 * i18n 網羅テスト: エンジンが発生させうる全異常タイプに、両言語のタイトル文言が
 * 存在することを保証する（欠けると「リングだけの無文字カード」が出るため）。
 * 実行: node --test test/i18n-coverage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const RE = require('../src/risk-engine.js');
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const LOCALES = ['ja', 'en'];
const dicts = Object.fromEntries(LOCALES.map(l => [
    l, JSON.parse(readFileSync(join(root, '_locales', l, 'messages.json'), 'utf8'))
]));

for (const locale of LOCALES) {
    test(`${locale}: 全異常タイプにタイトル文言がある`, () => {
        for (const type of RE.ANOMALY_TYPES) {
            const key = `an_${type}_title`;
            const m = dicts[locale][key];
            assert.ok(m && m.message && m.message.trim(), `${locale} に ${key} がありません`);
        }
    });

    test(`${locale}: 全注記タイプに文言がある`, () => {
        for (const type of RE.NOTE_TYPES) {
            const key = `note_${type}`;
            const m = dicts[locale][key];
            assert.ok(m && m.message && m.message.trim(), `${locale} に ${key} がありません`);
        }
    });

    test(`${locale}: UI が使う共通キーが揃っている`, () => {
        const REQUIRED = [
            'dlgTitle', 'dlgSubAnomalies', 'dlgSubStrict', 'dlgAllRecipients',
            'btnCancel', 'btnSend', 'ackHint', 'ackAllDone',
            'lblSubject', 'lblAttachments',
            'toastOkTo', 'toastOkMore',
            // レビューのお願い（reviewToast）と設定画面の常設リンク
            'rvQ', 'rvYes', 'rvNo', 'rvThanks', 'rvRate', 'rvSorry', 'rvFeedback', 'rvNever',
            'opt_review_note', 'opt_review_link', 'opt_feedback_link'
        ];
        for (const key of REQUIRED) {
            const m = dicts[locale][key];
            assert.ok(m && m.message && m.message.trim(), `${locale} に ${key} がありません`);
        }
    });
}

test('ja と en のキー集合が一致する', () => {
    const ja = Object.keys(dicts.ja).sort();
    const en = Object.keys(dicts.en).sort();
    assert.deepEqual(ja, en);
});
