#!/usr/bin/env bash

set -euo pipefail

readonly mounted_ssh_stage_dir="${DACCI_RUNTIME_SSH_STAGE_DIR:-/var/run/dacci-host-ssh-stage}"
readonly mounted_ssh_live_dir="${DACCI_RUNTIME_SSH_SOURCE_DIR:-/var/run/dacci-host-ssh-live}"
readonly runtime_home="${HOME:-/tmp/dacci-home}"
readonly runtime_ssh_dir="${runtime_home}/.ssh"
readonly runtime_ssh_config="${runtime_ssh_dir}/config"
readonly runtime_user_ssh_config="${runtime_ssh_dir}/config.user"
readonly runtime_generated_ssh_config="${runtime_ssh_dir}/.dacci-generated.conf"
readonly runtime_known_hosts="${runtime_ssh_dir}/known_hosts"

build_managed_ssh_config() {
  local has_user_config="${1}"

  printf 'Include ~/.ssh/.dacci-generated.conf\n'
  if [[ "${has_user_config}" == "1" ]]; then
    printf 'Include ~/.ssh/config.user\n'
  fi
  printf '\n'
}

copy_ssh_source_with_fallback() {
  local target_dir="${1}"
  local copy_error_log="${target_dir}.copy-error.log"
  local source_dir

  for source_dir in "${mounted_ssh_live_dir}" "${mounted_ssh_stage_dir}"; do
    if [[ ! -d "${source_dir}" ]]; then
      continue
    fi

    rm -rf -- "${target_dir}"
    mkdir -p -- "${target_dir}"

    if cp -RL -- "${source_dir}/." "${target_dir}/" 2>"${copy_error_log}"; then
      rm -f -- "${copy_error_log}"
      return 0
    fi

    if [[ "${source_dir}" == "${mounted_ssh_live_dir}" && -d "${mounted_ssh_stage_dir}" ]]; then
      printf 'dacci api entrypoint: failed to copy live SSH source %s, falling back to staged snapshot: %s\n' "${source_dir}" "$(tr '\n' ' ' < "${copy_error_log}")" >&2
      continue
    fi

    printf 'dacci api entrypoint: failed to copy SSH source %s, continuing with an empty runtime SSH directory: %s\n' "${source_dir}" "$(tr '\n' ' ' < "${copy_error_log}")" >&2
  done

  rm -rf -- "${target_dir}"
  mkdir -p -- "${target_dir}"
  rm -f -- "${copy_error_log}"
}

bootstrap_runtime_ssh_dir() {
  local has_user_config="0"
  local temp_ssh_dir
  local temp_ssh_config
  local temp_runtime_user_ssh_config
  local temp_runtime_generated_ssh_config
  local temp_runtime_known_hosts

  temp_ssh_dir="$(mktemp -d "${runtime_home}/.ssh.bootstrap.XXXXXX")"
  temp_ssh_config="${temp_ssh_dir}/config"
  temp_runtime_user_ssh_config="${temp_ssh_dir}/config.user"
  temp_runtime_generated_ssh_config="${temp_ssh_dir}/.dacci-generated.conf"
  temp_runtime_known_hosts="${temp_ssh_dir}/known_hosts"

  copy_ssh_source_with_fallback "${temp_ssh_dir}"

  if [[ -f "${temp_ssh_config}" ]]; then
    mv -- "${temp_ssh_config}" "${temp_runtime_user_ssh_config}"
    has_user_config="1"
  fi

  touch -- "${temp_runtime_generated_ssh_config}" "${temp_runtime_known_hosts}"
  chmod 600 -- "${temp_runtime_generated_ssh_config}" "${temp_runtime_known_hosts}"
  build_managed_ssh_config "${has_user_config}" > "${temp_ssh_config}"
  chmod 600 -- "${temp_ssh_config}"
  find "${temp_ssh_dir}" -type d -exec chmod 700 {} +
  find "${temp_ssh_dir}" -type f -exec chmod 600 {} +

  rm -rf -- "${runtime_ssh_dir}"
  mv -- "${temp_ssh_dir}" "${runtime_ssh_dir}"
}

mkdir -p -- "${runtime_home}"
chmod 700 -- "${runtime_home}"
bootstrap_runtime_ssh_dir
mkdir -p -- "${runtime_ssh_dir}"

if [[ -z "${GIT_SSH_COMMAND:-}" ]]; then
  export GIT_SSH_COMMAND="ssh -F ${runtime_ssh_config} -o UserKnownHostsFile=${runtime_known_hosts}"
fi

exec "$@"
