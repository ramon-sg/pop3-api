#!/usr/bin/env bash
#
# Installs the packed client (the same .tgz a release publishes) in real
# consumer projects and runs Playwright + tsc there: ESM and CommonJS, with
# the moduleResolution modes we support. Catches packaging bugs (exports,
# types) that the unit tests cannot see.
#
# Needs node, npm and network (installs @playwright/test and typescript).
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$CLIENT_DIR"
bun run build >/dev/null
bun pm pack --destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/pop3-api-client-*.tgz)"
PLAYWRIGHT="$(node -p "require('./package.json').devDependencies['@playwright/test']")"

run_consumer() {
  local name="$1" type="$2" module="$3" resolution="$4"
  local dir="$WORK/$name"

  echo "▶ $name (type: ${type:-commonjs}, module: $module, moduleResolution: $resolution)"
  mkdir -p "$dir/tests"
  cp "$CLIENT_DIR/test/consumer/fixtures.ts" "$dir/tests/"
  cp "$CLIENT_DIR/test/consumer/mailbox.spec.ts" "$dir/tests/"

  node -e '
    const [dir, type] = process.argv.slice(1);
    const pkg = { name: "consumer", private: true };
    if (type) pkg.type = type;
    require("fs").writeFileSync(dir + "/package.json", JSON.stringify(pkg, null, 2));
  ' "$dir" "$type"

  cat > "$dir/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "$module",
    "moduleResolution": "$resolution",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["tests"]
}
JSON

  (
    cd "$dir"
    npm install --silent --no-audit --no-fund \
      "$TARBALL" "@playwright/test@$PLAYWRIGHT" typescript @types/node
    npx tsc -p .
    npx playwright test --reporter=line
  )
}

run_consumer esm-bundler module esnext bundler
run_consumer esm-nodenext module nodenext nodenext
run_consumer cjs-bundler "" esnext bundler
run_consumer cjs-nodenext "" nodenext nodenext

echo "✔ every consumer passed"
