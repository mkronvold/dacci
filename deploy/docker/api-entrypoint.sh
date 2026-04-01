#!/usr/bin/env bash

set -euo pipefail

readonly mounted_ssh_dir="/var/run/dacci-host-ssh"
readonly runtime_ssh_dir="/root/.ssh"

if [[ -d "${mounted_ssh_dir}" ]]; then
  rm -rf -- "${runtime_ssh_dir}"
  mkdir -p -- "${runtime_ssh_dir}"
  cp -a -- "${mounted_ssh_dir}/." "${runtime_ssh_dir}/"
  chown -R root:root "${runtime_ssh_dir}"
  chmod 700 -- "${runtime_ssh_dir}"
fi

exec "$@"
