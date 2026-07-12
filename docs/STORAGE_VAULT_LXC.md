# Storage vault and dedicated LXC

This runbook places the print application in a new unprivileged LXC while the
durable PostgreSQL data, uploaded models, PDFs, and Redis AOF live on
`/dev/sde1`. It uses LUKS2, LVM, and separate ext4 filesystems so uploaded files
cannot consume PostgreSQL's free space.

## Important boundaries

- The commands through `cryptsetup luksFormat`, `pvcreate`, `vgcreate`,
  `lvcreate`, and `mkfs.ext4` are destructive. Verify the disk by model, serial,
  size, and existing signatures before running them.
- Run disk and `pct` commands on the Proxmox host, not inside an LXC.
- The current LXC can see `sde1` in sysfs, but has no `/dev/sde1` device node.
  Do not pass the raw block device into the application LXC. Mount filesystems
  on the host and bind only the required directories into the LXC.
- A single SSD is still a single point of failure. Encryption, LVM, and snapshots
  do not replace an offline or off-host backup.
- An unprivileged LXC shares the Proxmox kernel. A small VM is the stronger
  boundary for a native parser such as OrcaSlicer. If LXC is required, keep it
  unprivileged and do not add raw devices, broad host mounts, or privileged mode.

## Recommended allocation

The 298.1 GB device is about 277 GiB. This layout leaves free extents for growth.

| Logical volume | Size | Host mount | Purpose |
| --- | ---: | --- | --- |
| `print_db` | 32 GiB | `/srv/vault/print/postgres` | PostgreSQL only |
| `print_files` | 200 GiB | `/srv/vault/print/files` | uploads and PDFs |
| `print_redis` | 8 GiB | `/srv/vault/print/redis` | Redis AOF and queue |
| `misc` | 20 GiB | `/srv/vault/misc` | storage for other services |

Do not mount `misc` into the print LXC. Give each future LXC only its own logical
volume or directory.

## 1. Identify and test the device

On the Proxmox host:

```bash
lsblk -e7 -o NAME,PATH,SIZE,MODEL,SERIAL,TRAN,FSTYPE,LABEL,UUID,MOUNTPOINTS
smartctl -a /dev/sde
blkid /dev/sde1 || true
wipefs -n /dev/sde1
findmnt -S /dev/sde1
```

Stop if the serial/model is not the intended 298.1 GB device, if `findmnt` shows
a mount, or if `wipefs -n` reports data that must be preserved.

## 2. Encrypt and divide the partition

Install tools, create the LUKS container, then build normal LVM volumes inside
it. Choose a strong passphrase and store a recovery copy outside this host.

```bash
apt update
apt install -y cryptsetup lvm2 smartmontools

cryptsetup luksFormat --type luks2 --pbkdf argon2id /dev/sde1
cryptsetup open /dev/sde1 vault_crypt

pvcreate /dev/mapper/vault_crypt
vgcreate vaultvg /dev/mapper/vault_crypt
lvcreate -L 32G  -n print_db vaultvg
lvcreate -L 200G -n print_files vaultvg
lvcreate -L 8G   -n print_redis vaultvg
lvcreate -L 20G  -n misc vaultvg

mkfs.ext4 -L print_db /dev/vaultvg/print_db
mkfs.ext4 -L print_files /dev/vaultvg/print_files
mkfs.ext4 -L print_redis /dev/vaultvg/print_redis
mkfs.ext4 -L vault_misc /dev/vaultvg/misc
```

Verify before continuing:

```bash
cryptsetup status vault_crypt
pvs
vgs
lvs -o lv_name,lv_size,data_percent,metadata_percent,devices
```

## 3. Configure persistent mounts

Create mountpoints:

```bash
install -d -m 0750 /srv/vault/print/postgres
install -d -m 0750 /srv/vault/print/files
install -d -m 0750 /srv/vault/print/redis
install -d -m 0750 /srv/vault/misc
```

Get the LUKS and filesystem UUIDs:

```bash
blkid /dev/sde1 /dev/vaultvg/print_db /dev/vaultvg/print_files \
  /dev/vaultvg/print_redis /dev/vaultvg/misc
```

Add one line to `/etc/crypttab`, using the LUKS UUID reported for `/dev/sde1`:

```text
vault_crypt UUID=<LUKS_UUID> none luks
```

Add these lines to `/etc/fstab`, replacing each placeholder with that
filesystem's UUID:

```text
UUID=<PRINT_DB_UUID>    /srv/vault/print/postgres ext4 defaults,noatime,nodev,nosuid,noexec,errors=remount-ro 0 2
UUID=<PRINT_FILES_UUID> /srv/vault/print/files    ext4 defaults,noatime,nodev,nosuid,noexec,errors=remount-ro 0 2
UUID=<PRINT_REDIS_UUID> /srv/vault/print/redis    ext4 defaults,noatime,nodev,nosuid,noexec,errors=remount-ro 0 2
UUID=<MISC_UUID>        /srv/vault/misc           ext4 defaults,noatime,nodev,nosuid,noexec,errors=remount-ro 0 2
```

Then test the exact boot path before putting data on it:

```bash
systemctl daemon-reload
mount -a
findmnt /srv/vault/print/postgres /srv/vault/print/files \
  /srv/vault/print/redis /srv/vault/misc
df -hT /srv/vault/print/postgres /srv/vault/print/files /srv/vault/print/redis
```

With `none` in `crypttab`, the Proxmox host asks for the passphrase during boot.
An auto-unlock key stored on the same host protects a removed disk, but not a
stolen or compromised host. TPM2 or a network-bound key is preferable if
unattended boot is required.

## 4. Create the application LXC

Create a Debian 13 unprivileged LXC with at least 6 vCPU, 8 GiB RAM, 2 GiB swap,
and a 24-32 GiB root disk for images and logs. Enable nesting and keyctl for
Docker:

```bash
pct set <CTID> -features nesting=1,keyctl=1
```

For a standard unprivileged UID map (`0` in the LXC maps to `100000` on the
host), make each mount root owned by mapped root before attaching it:

```bash
chown 100000:100000 /srv/vault/print/postgres
chown 100000:100000 /srv/vault/print/files
chown 100000:100000 /srv/vault/print/redis
```

Confirm the actual mapping in `pct config <CTID>` and `/etc/subuid`; substitute
the correct mapped root instead of `100000` if the CT has a custom map.

Attach only the three print filesystems:

```bash
pct set <CTID> -mp0 /srv/vault/print/postgres,mp=/srv/print-data/postgres,backup=0
pct set <CTID> -mp1 /srv/vault/print/files,mp=/srv/print-data/files,backup=0
pct set <CTID> -mp2 /srv/vault/print/redis,mp=/srv/print-data/redis,backup=0
pct start <CTID>
```

`backup=0` is intentional because Proxmox vzdump does not reliably protect host
bind mounts. The backup section below covers these paths explicitly.

Inside the new LXC, prepare numeric ownership used by the Docker images:

```bash
install -d -m 0700 /srv/print-data/files/uploads
install -d -m 0700 /srv/print-data/files/pdfs

chown 70:70 /srv/print-data/postgres
chmod 0700 /srv/print-data/postgres

chown 1001:1001 /srv/print-data/files /srv/print-data/files/uploads
chmod 0700 /srv/print-data/files /srv/print-data/files/uploads
chown 1001:1001 /srv/print-data/files/pdfs
chmod 0700 /srv/print-data/files/pdfs

chown 999:1000 /srv/print-data/redis
chmod 0700 /srv/print-data/redis
```

PostgreSQL Alpine currently uses uid/gid `70:70`; Redis Alpine currently uses
`999:1000`; the web image and durable model files use uid/gid `1001:1001`.
The slicer receives a private scratch copy under a per-job uid and never needs
group access to this mount. Re-check image IDs after a major image change.

## 5. Install and configure the application

Install Docker from Docker's official Debian repository, clone this repository
under `/opt/print.rish.pw`, and create `.env` from `.env.example`. Add these
vault paths:

```text
PRINT_DB_DIR=/srv/print-data/postgres
PRINT_UPLOAD_DIR=/srv/print-data/files/uploads
PRINT_PDF_DIR=/srv/print-data/files/pdfs
PRINT_REDIS_DIR=/srv/print-data/redis
```

Generate new secrets for the new deployment and protect the file:

```bash
openssl rand -hex 32
chmod 0600 .env
docker compose -f docker-compose.yml -f docker-compose.vault.yml config --quiet
```

Do not start the public proxy until data is restored and verification passes.

## 6. Move data from the current LXC

Create a transfer directory in the old LXC. Stop new requests and workers while
leaving PostgreSQL up for the dump:

```bash
cd /root/print.rish.pw
install -d -m 0700 transfer
docker compose stop proxy web worker
docker compose exec -T postgres sh -c \
  'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > transfer/print.pgdump

docker run --rm -v print_uploads:/source:ro -v "$PWD/transfer":/backup alpine \
  tar -C /source -czf /backup/uploads.tar.gz .
docker run --rm -v print_pdfs:/source:ro -v "$PWD/transfer":/backup alpine \
  tar -C /source -czf /backup/pdfs.tar.gz .
sha256sum transfer/* > transfer/SHA256SUMS
```

Copy `transfer/` to the new LXC over SSH, verify checksums there, then extract:

```bash
sha256sum -c transfer/SHA256SUMS
tar -C /srv/print-data/files/uploads -xzf transfer/uploads.tar.gz
tar -C /srv/print-data/files/pdfs -xzf transfer/pdfs.tar.gz
chown -R 1001:1001 /srv/print-data/files/uploads
find /srv/print-data/files/uploads -type d -exec chmod 0700 {} +
find /srv/print-data/files/uploads -type f -exec chmod 0600 {} +
chown -R 1001:1001 /srv/print-data/files/pdfs
```

Start only the new data services and restore the logical dump:

```bash
docker compose -f docker-compose.yml -f docker-compose.vault.yml up -d postgres redis
docker compose -f docker-compose.yml -f docker-compose.vault.yml exec -T postgres \
  sh -c 'pg_restore --clean --if-exists --no-owner --no-privileges \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < transfer/print.pgdump
```

Redis is intentionally started clean. It contains queues, rate limits, and
cache coordination, not the authoritative quotation records. Existing queued
or running slice rows are not restored by a polling GET; an explicit new slice
POST is required to enqueue work again.

Start the app; the one-shot migration service applies newer Prisma migrations
and runtime-role grants before web/worker start:

```bash
docker compose -f docker-compose.yml -f docker-compose.vault.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.vault.yml ps
```

Verify before changing the reverse proxy:

```bash
curl -fsS "http://${PROXY_BIND:-127.0.0.1}:8080/api/health"
docker compose -f docker-compose.yml -f docker-compose.vault.yml logs --tail=100 migrate web worker
findmnt /srv/print-data/postgres /srv/print-data/files /srv/print-data/redis
```

Upload and slice a small known STL, open an existing quotation PDF, and compare
quotation/model counts between old and new PostgreSQL. Then point the upstream
proxy to the new LXC. Keep the old stack stopped but intact until the new system
has passed normal operation and at least one backup/restore test.

## 7. Backups and monitoring

Backups must leave `/dev/sde`; a second directory on the same encrypted disk is
not a backup. At minimum:

1. Nightly `pg_dump -Fc` to another host or disk.
2. Encrypted, incremental backup of uploads and PDFs with restic or borg.
3. Daily retention, weekly restore tests, and alerting on backup age.
4. SMART monitoring on `/dev/sde` and free-space alerts for every logical volume.
5. Keep at least one offline or immutable copy so an LXC compromise cannot erase
   every backup it can reach.

LVM snapshots can shorten a file-copy window, but PostgreSQL logical dumps remain
the portable source of truth and snapshots on the same SSD are not backups.
