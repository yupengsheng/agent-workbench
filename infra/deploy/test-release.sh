#!/usr/bin/env bash
set -Eeuo pipefail

archive_path=${1:?archive path is required}
deploy_root=${2:?deploy root is required}
release_id=${3:?release id is required}

if [[ ! "$deploy_root" = /* ]]; then
  echo "deploy root must be an absolute path" >&2
  exit 2
fi
if [[ ! "$release_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "release id contains unsupported characters" >&2
  exit 2
fi
if [[ ! -f "$archive_path" ]]; then
  echo "release archive not found: $archive_path" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "node and npm are required on the test instance" >&2
  exit 2
fi

node_major=$(node -p "Number(process.versions.node.split('.')[0])")
node_minor=$(node -p "Number(process.versions.node.split('.')[1])")
if [[ "$node_major" != "22" && "$node_major" != "24" ]]; then
  echo "Node.js 22.12+ or 24 is required on the test instance; found $(node --version)" >&2
  exit 2
fi
if [[ "$node_major" == "22" && "$node_minor" -lt 12 ]]; then
  echo "Node.js 22.12+ is required on the test instance; found $(node --version)" >&2
  exit 2
fi

release_dir="$deploy_root/releases/$release_id"
runtime_dir="$deploy_root/runtime"
mkdir -p "$deploy_root/releases" "$runtime_dir"
if [[ -e "$release_dir" ]]; then
  echo "release already exists: $release_id"
  exit 0
fi

mkdir -p "$release_dir"
tar -xzf "$archive_path" -C "$release_dir"
cd "$release_dir"

echo "Installing dependencies for release $release_id"
npm ci
echo "Building release $release_id"
npm run check

stop_service() {
  local name=$1
  local pid_file="$runtime_dir/$name.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid=$(cat "$pid_file")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

stop_service api
stop_service web
ln -sfn "$release_dir" "$deploy_root/current"

cd "$deploy_root/current"
HOST=127.0.0.1 PORT=4100 LOG_LEVEL=info \
  nohup npm run start --workspace @agent-workbench/api >"$runtime_dir/api.log" 2>&1 &
echo $! >"$runtime_dir/api.pid"

nohup npm run preview --workspace @agent-workbench/web -- --host 127.0.0.1 --port 5173 \
  >"$runtime_dir/web.log" 2>&1 &
echo $! >"$runtime_dir/web.pid"

wait_for_url() {
  local url=$1
  for _ in {1..30}; do
    if curl --fail --silent --show-error "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "health check failed: $url" >&2
  return 1
}

wait_for_url http://127.0.0.1:4100/healthz
wait_for_url http://127.0.0.1:5173/
printf 'deployed release %s\napi: http://127.0.0.1:4100\nweb: http://127.0.0.1:5173\n' "$release_id"
