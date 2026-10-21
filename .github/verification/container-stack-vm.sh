#!/usr/bin/env bash
set -euo pipefail
# Fork-only validation. Real guest resources and services; no resource mocks,
# paid runner, Windows change, registry push or uploaded image artifact.
source_root=$(realpath "${1:?source checkout is required}")
tools_root=$(realpath "${2:?verification tools directory is required}")
temp_root=$(realpath "${RUNNER_TEMP:?GitHub runner temporary directory is required}")
vm_root=$(mktemp -d "$temp_root/spaceapp-stack-vm.XXXXXXXX")
chmod 0700 "$vm_root"
export SPACEAPP_VM_ROOT="$vm_root"
guest_port=$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(('127.0.0.1',0))
    print(listener.getsockname()[1])
PY
)
qemu_pid=''
owned_live_qemu() {
  [[ "$qemu_pid" =~ ^[0-9]+$ ]] || return 1
  sudo cat "/proc/$qemu_pid/cmdline" 2>/dev/null | tr '\0' ' ' | grep -F -q -- "$vm_root/root.qcow2"
}
cleanup() {
  if [[ -f "$vm_root/qemu.pid" ]]; then
    qemu_pid=$(cat "$vm_root/qemu.pid")
    if owned_live_qemu; then
      sudo kill "$qemu_pid" 2>/dev/null || true
      for attempt in {1..20}; do
        if ! owned_live_qemu; then break; fi
        sleep 1
      done
      if owned_live_qemu; then sudo kill -KILL "$qemu_pid" 2>/dev/null || true; sleep 1; fi
      if owned_live_qemu; then echo 'Owned VM is still live; refusing to delete its disk.' >&2; return 1; fi
    fi
  fi
  local resolved_vm
  resolved_vm=$(realpath -m "$vm_root")
  case "$resolved_vm" in
    "$temp_root"/spaceapp-stack-vm.*) sudo rm -rf -- "$resolved_vm" ;;
    *) echo 'Unexpected VM state path; refusing deletion.' >&2; return 1 ;;
  esac
}
trap cleanup EXIT

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends qemu-system-x86 qemu-utils cloud-image-utils

# Pin the downloaded bytes against Canonical's official HTTPS checksum file.
cloud_base='https://cloud-images.ubuntu.com/noble/current'
cloud_name='noble-server-cloudimg-amd64.img'
curl --fail --location --proto '=https' --tlsv1.2 "$cloud_base/$cloud_name" --output "$vm_root/$cloud_name"
curl --fail --location --proto '=https' --tlsv1.2 "$cloud_base/SHA256SUMS" --output "$vm_root/SHA256SUMS"
( cd "$vm_root"; grep -E "^[a-f0-9]{64} .?${cloud_name}$" SHA256SUMS > image-checksum; test "$(wc -l < image-checksum)" -eq 1; sha256sum --check image-checksum )

# Fresh, test-only keys. The guest's SSH host key is pinned before boot; host
# checking stays enabled. Keys and cloud seed are never uploaded or printed.
ssh-keygen -q -t ed25519 -N '' -C 'ephemeral-spaceapp-proof-client' -f "$vm_root/client-key"
ssh-keygen -q -t ed25519 -N '' -C 'ephemeral-spaceapp-proof-host' -f "$vm_root/host-key"
python3 - <<'PY'
from pathlib import Path
import json,os
r=Path(os.environ['SPACEAPP_VM_ROOT'])
configuration={
    'groups':['docker'],
    'users':[{'name':'proof','shell':'/bin/bash','groups':['sudo','docker'],
              'sudo':['ALL=(ALL) NOPASSWD:ALL'],'lock_passwd':True,
              'ssh_authorized_keys':[r.joinpath('client-key.pub').read_text().strip()]}],
    'ssh_pwauth':False,'disable_root':True,
    'ssh_keys':{'ed25519_private':r.joinpath('host-key').read_text(),
                'ed25519_public':r.joinpath('host-key.pub').read_text().strip()},
    'package_update':True,'package_upgrade':False,
    'packages':['docker.io','docker-compose-v2'],
    'runcmd':[['systemctl','enable','--now','docker']]
}
r.joinpath('user-data').write_text('#cloud-config\n'+json.dumps(configuration)+'\n')
r.joinpath('meta-data').write_text('instance-id: spaceapp-disposable-container-proof\nlocal-hostname: spaceapp-proof\n')
PY
cloud-localds "$vm_root/seed.img" "$vm_root/user-data" "$vm_root/meta-data"
qemu-img create -f qcow2 -F qcow2 -b "$vm_root/$cloud_name" "$vm_root/root.qcow2" 40G
host_key=$(cut -d' ' -f1-2 "$vm_root/host-key.pub")
printf '[127.0.0.1]:%s %s\n' "$guest_port" "$host_key" > "$vm_root/known_hosts"
ssh_options=(-i "$vm_root/client-key" -p "$guest_port" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$vm_root/known_hosts" -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
guest='proof@127.0.0.1'
acceleration='kvm'
cpu_model='host'
if [[ ! -e /dev/kvm ]]; then acceleration='tcg'; cpu_model='max'; fi
host_cpus=$(nproc)
echo "Real Ubuntu guest: 8 vCPUs, 16 GiB virtual RAM, $acceleration acceleration on $host_cpus-CPU standard CI host."
sudo qemu-system-x86_64 -machine q35 -accel "$acceleration" -cpu "$cpu_model" -smp 8 -m 16384 \
  -drive "file=$vm_root/root.qcow2,if=virtio,format=qcow2" \
  -drive "file=$vm_root/seed.img,if=virtio,format=raw,readonly=on" \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$guest_port-:22" -device virtio-net-pci,netdev=net0 \
  -display none -serial "file:$vm_root/serial.log" -daemonize -pidfile "$vm_root/qemu.pid"

connected=0
for attempt in {1..120}; do
  if ssh "${ssh_options[@]}" "$guest" true > /dev/null 2> "$vm_root/ssh-startup.log"; then connected=1; break; fi
  qemu_pid=$(cat "$vm_root/qemu.pid")
  if ! sudo kill -0 "$qemu_pid" 2>/dev/null; then echo 'Guest VM exited before SSH was available.' >&2; exit 1; fi
  sleep 5
done
if [[ "$connected" != 1 ]]; then
  echo 'Guest VM stayed live but SSH did not become ready within the test budget.' >&2
  # Do not dump cloud-init user data or keys into public CI logs.
  exit 1
fi
ssh "${ssh_options[@]}" "$guest" 'sudo cloud-init status --wait; docker version; docker compose version; nproc; free -m; df -h /'

# Only this contribution's images enter the guest. No registry publication and
# no user credentials, browser profile or installed application data are copied.
docker save spaceapp-ci:core-amd64 spaceapp-ci:browser-amd64 spaceapp-ci:cli-amd64 | ssh "${ssh_options[@]}" "$guest" 'docker load'
docker run --rm --network none --entrypoint cat spaceapp-ci:core-amd64 /usr/local/bin/node | ssh "${ssh_options[@]}" "$guest" 'cat > /tmp/proof-node && sudo install -m 0755 /tmp/proof-node /usr/local/bin/node && rm /tmp/proof-node'
tar -C "$source_root" -cf - packages/run-spaceapp scripts/container-smoke.mjs | ssh "${ssh_options[@]}" "$guest" 'mkdir -p /tmp/spaceapp-source && tar -xf - -C /tmp/spaceapp-source'
cat "$tools_root/container-stack-proof.mjs" | ssh "${ssh_options[@]}" "$guest" 'cat > /tmp/container-stack-proof.mjs'
source_revision=$(git -C "$source_root" rev-parse HEAD)
if [[ ! "$source_revision" =~ ^[a-f0-9]{40}$ ]]; then echo 'Could not identify tested source.' >&2; exit 1; fi
ssh "${ssh_options[@]}" "$guest" "SOURCE_REVISION=$source_revision SPACEAPP_PROOF_ENVIRONMENT='real Ubuntu guest, 8 vCPUs/16 GiB, $acceleration on a free $host_cpus-core GitHub host' node /tmp/container-stack-proof.mjs --source /tmp/spaceapp-source --arch amd64 --report /tmp/stack-proof.json"
ssh "${ssh_options[@]}" "$guest" 'cat /tmp/stack-proof.json'
ssh "${ssh_options[@]}" "$guest" 'sudo shutdown -h now' || true
echo 'Real large-profile launcher proof finished; the EXIT trap removes the owned VM process and state.'
