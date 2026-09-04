#!/usr/bin/env bash
# tools/check.sh — everything that can fail without a browser.
#   1. parse every source file (including the DOM-only ones)
#   2. run the engine test suite
#   3. compile the shaders on a real GL ES 2.0 driver
set -uo pipefail
cd "$(dirname "$0")/.."
status=0

echo "== parsing sources"
for f in $(find src -name '*.js' | sort) tools/test.mjs tools/dump-shaders.mjs; do
  if node --check "$f" >/dev/null 2>&1; then
    echo "  ok   $f"
  else
    echo "  FAIL $f"
    node --check "$f" 2>&1 | sed 's/^/    /'
    status=1
  fi
done

echo
echo "== engine tests"
node tools/test.mjs || status=1

echo
echo "== shaders"
if python3 -c "import OpenGL" >/dev/null 2>&1; then
  node tools/dump-shaders.mjs >/dev/null && python3 tools/glsl.py || status=1
else
  echo "  skipped — PyOpenGL is not installed (pip install PyOpenGL)"
fi

echo
if [ $status -eq 0 ]; then echo "everything passed"; else echo "something failed"; fi
exit $status
