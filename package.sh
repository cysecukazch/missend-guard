#!/bin/bash
# Chrome ウェブストア提出用 zip を dist/ に作る。
# 開発用の manifest.json にある "key"（固定ID用）は、ストアでは Google が ID を
# 発行するため不要かつ紛らわしいので、提出用 zip からは自動で取り除く。
# （このフォルダ自体の manifest.json は変更しない＝開発環境の ID と学習データは維持）
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="dist/missend-guard-${VERSION}.zip"
STAGE="dist/_stage"

mkdir -p dist
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"

# ストアに含めるものだけコピー
cp -R src options help icons _locales "$STAGE/"
python3 - "$STAGE" <<'EOF'
import json, sys
m = json.load(open('manifest.json'))
m.pop('key', None)   # ストア提出版では固定IDキーを除去
json.dump(m, open(sys.argv[1] + '/manifest.json', 'w'), indent=2, ensure_ascii=False)
EOF

( cd "$STAGE" && zip -rq "../$(basename "$OUT")" . -x '*.DS_Store' )
rm -rf "$STAGE"

echo "created: $OUT"
python3 - "$OUT" <<'EOF'
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
m = json.loads(z.read('manifest.json'))
assert 'key' not in m, 'key が残っている!'
print('  version:', m['version'], '/ key removed:', 'key' not in m, '/ files:', len(z.namelist()))
EOF
