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
if [[ -f "$deploy_root/.env" ]]; then
  ln -sfn "$deploy_root/.env" "$release_dir/apps/api/.env"
  set -a
  # shellcheck disable=SC1091
  source "$deploy_root/.env"
  set +a
fi
cd "$release_dir"

echo "Installing dependencies for release $release_id"
npm ci
echo "Building release $release_id"
npm run check

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Applying database migrations"
  npm run db:migrate --workspace @agent-workbench/api
fi

configure_proxy() {
  local source="$release_dir/infra/deploy/nginx-agent-workbench-test.conf"
  local target=/etc/nginx/conf.d/agent-workbench-test.conf
  if [[ ! -f "$source" ]]; then
    return 0
  fi
  if ! command -v nginx >/dev/null 2>&1; then
    echo "nginx is not installed; skipping public reverse proxy configuration" >&2
    return 0
  fi

  local backup
  local had_config=0
  backup=$(mktemp)
  if [[ -f "$target" ]]; then
    cp "$target" "$backup"
    had_config=1
  fi
  install -m 0644 "$source" "$target"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    rm -f "$backup"
    return 0
  fi

  if [[ "$had_config" == "1" ]]; then
    install -m 0644 "$backup" "$target"
  else
    rm -f "$target"
  fi
  rm -f "$backup"
  echo "nginx configuration test failed; previous configuration restored" >&2
  nginx -t
  exit 1
}

configure_proxy

process_tree() {
  local pid=$1 child
  while read -r child; do
    [[ "$child" =~ ^[0-9]+$ ]] && process_tree "$child"
  done < <(pgrep -P "$pid" || true)
  printf '%s\n' "$pid"
}

stop_service() {
  local name=$1
  local pid_file="$runtime_dir/$name.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid=$(cat "$pid_file")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      local -a service_pids
      mapfile -t service_pids < <(process_tree "$pid")
      kill "${service_pids[@]}" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "${service_pids[@]}" 2>/dev/null || break
        sleep 0.25
      done
      kill -9 "${service_pids[@]}" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

stop_service runner
stop_service api
stop_service web
ln -sfn "$release_dir" "$deploy_root/current"

cd "$deploy_root/current"
HOST=127.0.0.1 PORT=4100 LOG_LEVEL=info \
  nohup node apps/api/dist/main.js >"$runtime_dir/api.log" 2>&1 &
echo $! >"$runtime_dir/api.pid"

nohup node node_modules/vite/bin/vite.js preview apps/web --host 127.0.0.1 --port 5173 --strictPort \
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

SERVICE_NAME=agent-workbench-runner NODE_ENV=production \
  AGENT_WORKBENCH_ENABLE_SHELL="${AGENT_WORKBENCH_ENABLE_SHELL:-true}" \
  nohup node apps/runner/dist/main.js >"$runtime_dir/runner.log" 2>&1 &
echo $! >"$runtime_dir/runner.pid"

wait_for_url http://127.0.0.1:4100/healthz
wait_for_url http://127.0.0.1:5173/
sleep 1
for service in api web runner; do
  kill -0 "$(cat "$runtime_dir/$service.pid")"
done
printf 'deployed release %s\napi: http://127.0.0.1:4100\nweb: http://127.0.0.1:5173\n' "$release_id"
