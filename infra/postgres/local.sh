#!/usr/bin/env bash
set -euo pipefail
umask 077
runtime_root=${JUANCA_RUNTIME_ROOT:-/home/jorge/.local/share/juanca-shadow}
pg_root="$runtime_root/runtime/root"
export LD_LIBRARY_PATH="$pg_root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
pg_bin="$pg_root/usr/lib/postgresql/16/bin"
mkdir -p "$runtime_root/socket"
chmod 700 "$runtime_root" "$runtime_root/socket"
case "${1:-status}" in
 bootstrap)
  mkdir -p "$runtime_root/runtime/packages"
  cd "$runtime_root/runtime/packages"
  apt-get download postgresql-16=16.15-0ubuntu0.24.04.1 postgresql-client-16=16.15-0ubuntu0.24.04.1 libpq5=16.15-0ubuntu0.24.04.1
  for package in *.deb; do dpkg-deb -x "$package" "$pg_root"; done
  ;;
 start)
  if [[ ! -f "$runtime_root/postgres/PG_VERSION" ]]; then
    "$pg_bin/initdb" -D "$runtime_root/postgres" -L "$pg_root/usr/share/postgresql/16" --auth-local=trust --auth-host=reject --encoding=UTF8 --locale=C.UTF-8 > "$runtime_root/initdb.log"
    cat >> "$runtime_root/postgres/postgresql.conf" <<CONF
listen_addresses = ''
port = 55432
unix_socket_directories = '$runtime_root/socket'
unix_socket_permissions = 0700
external_pid_file = '$runtime_root/postgres.pid'
max_connections = 25
shared_buffers = '32MB'
CONF
  fi
  if ! "$pg_bin/pg_ctl" -D "$runtime_root/postgres" status >/dev/null 2>&1; then
   "$pg_bin/pg_ctl" -D "$runtime_root/postgres" -l "$runtime_root/postgres.log" -w start
  fi
  ;;
 stop) "$pg_bin/pg_ctl" -D "$runtime_root/postgres" -m fast -w stop ;;
 status) "$pg_bin/pg_ctl" -D "$runtime_root/postgres" status ;;
 *) echo 'Usage: local.sh bootstrap|start|stop|status' >&2; exit 2 ;;
esac
