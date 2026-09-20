#!/usr/bin/env bash
set -Eeuo pipefail

deploy_root=${1:-/opt/agent-workbench-test}
env_file="$deploy_root/.env"
compose_file="$deploy_root/current/infra/compose/compose.yaml"

if [[ ! -f "$compose_file" ]]; then
  echo "deployed compose file not found: $compose_file" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required on the test instance" >&2
  exit 2
fi

mkdir -p "$deploy_root"
if [[ ! -f "$env_file" ]]; then
  password=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  cat >"$env_file" <<EOF
POSTGRES_DB=agent_workbench
POSTGRES_USER=agent_workbench
POSTGRES_PASSWORD=$password
POSTGRES_PORT=5432
DATABASE_URL=postgres://agent_workbench:$password@127.0.0.1:5432/agent_workbench
DB_POOL_MAX=10
DB_CONNECT_TIMEOUT_MS=3000
DB_IDLE_TIMEOUT_MS=30000
EOF
  chmod 600 "$env_file"
fi

docker compose --env-file "$env_file" -f "$compose_file" -p agent-workbench-test up -d postgres
docker compose --env-file "$env_file" -f "$compose_file" -p agent-workbench-test ps
