import { deflateSync } from 'node:zlib';

/**
 * The installer is embedded in the ASAR-protected main process.  Candidate
 * archives never get to supply the code which establishes their own trust:
 * this program opens each archive once with O_NOFOLLOW, verifies that exact
 * snapshot, and parses/extracts only the bytes held in memory.
 */
export const WSL_RUNTIME_INSTALLER_LOADER =
  "import base64,sys,zlib;exec(compile(zlib.decompress(base64.b64decode(sys.argv.pop(1))), '<agent-fleet-runtime-installer>', 'exec'))";

export const WSL_RUNTIME_INSTALLER_PROGRAM = deflateSync(Buffer.from(String.raw`
import base64
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import uuid
from pathlib import Path, PurePosixPath

MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_FILES = 256
MAX_RECEIPT_BYTES = 64 * 1024
MAX_CONTEXT_BYTES = 256 * 1024
MAX_CONFIG_BYTES = 64 * 1024
MAX_RECEIPT_RELEASES = 64
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
DIGEST_RE = re.compile(r"^[a-f0-9]{64}$")
MACHINE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
PUBLIC_COMMANDS = (
    "wtmux", "wtmux-agent", "wtmux-bridge", "wtmux-conversation", "wtmux-directory", "wtmux-host",
    "wtmux-host-runtime", "wtmux-registry", "wtmux-pair-client", "wtmux-pairing", "wtmux-runtime",
    "wtmux-scheduler", "wtmux-shell", "wtmux-settings", "wtmux-client-policy", "wtmux-diagnostics",
    "wtmux-fleet-config", "wtmux-runtime-release", "agent-fleet-release-set",
)
REGISTRY_BEGIN = "# BEGIN wtmux-runtime registry"
REGISTRY_END = "# END wtmux-runtime registry"
MANAGED_REGISTRY_BEGIN = "# BEGIN wtmux-managed shared-registry"
# First wtmux client-runtime sequence whose wtmux-fleet-config has render-config.
CONFIG_RENDERER_MIN_SEQUENCE = 78

def fail(message):
    raise RuntimeError(message)

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("trusted installer JSON contains a duplicate field")
        result[key] = value
    return result

def parse_json(payload, label):
    try:
        return json.loads(payload.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} is invalid") from error

def exact(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        fail(f"{label} fields are invalid")
    return value

def safe_version(value, label="runtime version"):
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        fail(f"{label} is invalid")
    return value

def safe_digest(value, label):
    if not isinstance(value, str) or not DIGEST_RE.fullmatch(value):
        fail(f"{label} is invalid")
    return value

def safe_member(value, label):
    path = PurePosixPath(value) if isinstance(value, str) else PurePosixPath(".")
    if (
        not isinstance(value, str) or not value or "\\" in value or path.is_absolute()
        or path.as_posix() != value or any(part in ("", ".", "..") for part in path.parts)
    ):
        fail(f"{label} path is unsafe")
    return value

def absolute_path(value):
    return Path(os.path.abspath(os.path.expanduser(value)))

def artifact_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or "\0" in value:
        fail("artifact path is invalid")
    if value.startswith("/"):
        return absolute_path(value)
    try:
        converted = subprocess.run(
            ["wslpath", "-a", value], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("Windows artifact path cannot be resolved in WSL") from error
    path = converted.stdout.rstrip("\r\n")
    if converted.returncode != 0 or not path.startswith("/") or "\n" in path or "\r" in path:
        fail("Windows artifact path cannot be resolved in WSL")
    return absolute_path(path)

def snapshot_artifact(value, expected_size_value, expected_digest, label):
    path = artifact_path(value)
    try:
        expected_size = int(expected_size_value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{label} size is invalid") from error
    safe_digest(expected_digest, f"{label} checksum")
    if expected_size < 1 or expected_size > MAX_ARCHIVE_BYTES:
        fail(f"{label} size is invalid")
    descriptor = -1
    try:
        path_stat = os.lstat(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        before = os.fstat(descriptor)
        identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        if (
            not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(path_stat.st_mode)
            or (path_stat.st_dev, path_stat.st_ino) != (before.st_dev, before.st_ino)
            or before.st_nlink != 1 or before.st_size != expected_size
        ):
            fail(f"{label} is missing or unsafe")
        chunks = []
        remaining = expected_size
        digest = hashlib.sha256()
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                fail(f"{label} changed while it was read")
            chunks.append(chunk)
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            fail(f"{label} changed while it was read")
        after = os.fstat(descriptor)
        if identity != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            fail(f"{label} changed while it was read")
        if digest.hexdigest() != expected_digest:
            fail(f"{label} checksum does not match")
        return b"".join(chunks)
    except OSError as error:
        raise RuntimeError(f"{label} is missing or unsafe") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)

def archive_members(snapshot, label):
    try:
        archive = tarfile.open(fileobj=io.BytesIO(snapshot), mode="r:")
    except tarfile.TarError as error:
        raise RuntimeError(f"{label} is not a valid uncompressed tar archive") from error
    with archive:
        members = archive.getmembers()
        if not (1 <= len(members) <= MAX_FILES + 1):
            fail(f"{label} member count is invalid")
        result = {}
        total = 0
        for member in members:
            name = safe_member(member.name, label)
            if name in result or not member.isfile() or member.size < 0 or member.size > MAX_FILE_BYTES:
                fail(f"{label} member is invalid: {name}")
            handle = archive.extractfile(member)
            if handle is None:
                fail(f"{label} member cannot be read: {name}")
            payload = handle.read(member.size + 1)
            if len(payload) != member.size:
                fail(f"{label} member size does not match: {name}")
            total += len(payload)
            if total > MAX_ARCHIVE_BYTES:
                fail(f"{label} expanded payload is too large")
            result[name] = (payload, stat.S_IMODE(member.mode))
        return result

def parse_runtime_manifest(payload, expected_version, expected_manifest_digest):
    if hashlib.sha256(payload).hexdigest() != expected_manifest_digest:
        fail("runtime manifest checksum does not match")
    manifest = exact(parse_json(payload, "runtime manifest"), {
        "formatVersion", "version", "components", "source", "target", "files",
    }, "runtime manifest")
    if manifest["formatVersion"] != 2 or manifest["version"] != expected_version:
        fail("runtime manifest identity is invalid")
    components = exact(manifest["components"], {
        "clientRuntime", "hostRuntime", "providerAdapters", "contracts",
    }, "runtime components")
    for name, component in components.items():
        exact(component, {"sequence", "version"}, f"runtime {name} component")
        if (
            not isinstance(component["sequence"], int) or isinstance(component["sequence"], bool)
            or not (1 <= component["sequence"] <= 2**53 - 1)
        ):
            fail(f"runtime {name} component sequence is invalid")
        safe_version(component["version"], f"runtime {name} component version")
    if any(components[name]["version"] != expected_version for name in (
        "clientRuntime", "hostRuntime", "providerAdapters",
    )):
        fail("runtime component versions disagree")
    source = exact(manifest["source"], {
        "schemaVersion", "repository", "commit", "license", "contractPackageVersion",
    }, "runtime source")
    if (
        source["schemaVersion"] != 1 or not isinstance(source["repository"], str)
        or not source["repository"].startswith("https://")
        or not re.fullmatch(r"[a-f0-9]{40}", source["commit"] if isinstance(source["commit"], str) else "")
        or source["license"] not in {"MIT", "NOASSERTION"}
    ):
        fail("runtime source provenance is invalid")
    safe_version(source["contractPackageVersion"], "runtime contract package version")
    if components["contracts"]["version"] != source["contractPackageVersion"]:
        fail("runtime contract component version disagrees")
    target = exact(manifest["target"], {"platform", "architecture", "prefix"}, "runtime target")
    if (
        target["platform"] not in {"linux", "termux"}
        or target["architecture"] not in {"x86_64", "arm64", "universal"}
        or not isinstance(target["prefix"], str)
        or (not target["prefix"].startswith("/")
            and not (target["platform"] == "linux" and target["prefix"] == "~/.local"))
        or len(target["prefix"]) > 256
    ):
        fail("runtime target metadata is invalid")
    files = manifest["files"]
    if not isinstance(files, list) or not (1 <= len(files) <= MAX_FILES):
        fail("runtime manifest file list is invalid")
    seen = set()
    total = 0
    for item in files:
        exact(item, {"path", "sha256", "size", "mode"}, "runtime file")
        relative = safe_member(item["path"], "runtime file")
        if relative == "runtime-manifest.json" or relative in seen:
            fail("runtime manifest contains a duplicate path")
        safe_digest(item["sha256"], "runtime file checksum")
        if (
            not isinstance(item["size"], int) or isinstance(item["size"], bool)
            or not (0 <= item["size"] <= MAX_FILE_BYTES) or item["mode"] not in (0o644, 0o755)
        ):
            fail(f"runtime file metadata is invalid: {relative}")
        total += item["size"]
        if total > MAX_ARCHIVE_BYTES:
            fail("runtime manifest payload is too large")
        seen.add(relative)
    return manifest

def verified_runtime_payloads(snapshot, version, manifest_digest):
    members = archive_members(snapshot, "runtime archive")
    manifest_entry = members.get("runtime-manifest.json")
    if manifest_entry is None:
        fail("runtime archive has no manifest")
    manifest = parse_runtime_manifest(manifest_entry[0], safe_version(version), safe_digest(manifest_digest, "runtime manifest checksum"))
    expected = {"runtime-manifest.json", *(item["path"] for item in manifest["files"])}
    if set(members) != expected:
        fail("runtime archive contents do not match its manifest")
    for item in manifest["files"]:
        payload, mode = members[item["path"]]
        if len(payload) != item["size"] or mode != item["mode"] or hashlib.sha256(payload).hexdigest() != item["sha256"]:
            fail(f"runtime file integrity check failed: {item['path']}")
    return manifest_entry[0], manifest, members

def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def atomic_bytes(path, payload, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}")
    descriptor = -1
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
        written = 0
        while written < len(payload):
            count = os.write(descriptor, payload[written:])
            if count <= 0:
                fail(f"cannot write {path.name}")
            written += count
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

def safe_target(value, label, allow_empty=True):
    if value == "" and allow_empty:
        return ""
    path = PurePosixPath(value) if isinstance(value, str) else PurePosixPath(".")
    if path.is_absolute() or len(path.parts) != 2 or path.parts[0] != "releases" or not VERSION_RE.fullmatch(path.parts[1]):
        fail(f"{label} is invalid")
    return value

def read_link(root, name):
    path = root / name
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return ""
    if not stat.S_ISLNK(metadata.st_mode):
        fail(f"runtime {name} link is unsafe")
    return safe_target(os.readlink(path), f"runtime {name} link")

def switch_link(root, name, target):
    safe_target(target, f"runtime {name} target", allow_empty=False)
    temporary = root / f".{name}.{uuid.uuid4().hex}"
    os.symlink(target, temporary)
    try:
        os.replace(temporary, root / name)
        fsync_directory(root)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

def remove_link(root, name):
    path = root / name
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISLNK(metadata.st_mode):
        fail(f"runtime {name} path is unsafe")
    path.unlink()
    fsync_directory(root)

def runtime_lock(root):
    descriptor = os.open(root / ".runtime.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    os.fchmod(descriptor, 0o600)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    return descriptor

def write_release(target, manifest_payload, manifest, members):
    target.mkdir(mode=0o700)
    for item in manifest["files"]:
        destination = target / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, item["mode"])
        try:
            payload = members[item["path"]][0]
            written = 0
            while written < len(payload):
                count = os.write(descriptor, payload[written:])
                if count <= 0:
                    fail(f"cannot write runtime file: {item['path']}")
                written += count
            os.fsync(descriptor)
            os.fchmod(descriptor, item["mode"])
        finally:
            os.close(descriptor)
    atomic_bytes(target / "runtime-manifest.json", manifest_payload, 0o600)

def read_regular(path, limit, label, expected_size=None, expected_mode=None):
    descriptor = -1
    try:
        before_path = os.lstat(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        before = os.fstat(descriptor)
        identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        if (
            not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before_path.st_mode)
            or (before_path.st_dev, before_path.st_ino) != (before.st_dev, before.st_ino)
            or before.st_nlink != 1 or before.st_size > limit
            or (expected_size is not None and before.st_size != expected_size)
            or (expected_mode is not None and stat.S_IMODE(before.st_mode) != expected_mode)
        ):
            fail(f"{label} is missing or unsafe")
        payload = b""
        chunks = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                fail(f"{label} changed while it was read")
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
        if identity != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            fail(f"{label} changed while it was read")
        return payload
    except OSError as error:
        raise RuntimeError(f"{label} is missing or unsafe") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)

def validate_release(root, target, expected_manifest_digest):
    target = safe_target(target, "runtime release", allow_empty=False)
    version = target.removeprefix("releases/")
    release = root / target
    metadata = os.lstat(release)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail("installed runtime release path is unsafe")
    manifest_payload = read_regular(release / "runtime-manifest.json", MAX_FILE_BYTES, "installed runtime manifest")
    manifest = parse_runtime_manifest(manifest_payload, version, expected_manifest_digest)
    expected_files = {"runtime-manifest.json", *(item["path"] for item in manifest["files"])}
    expected_directories = set()
    for relative in expected_files:
        parent = PurePosixPath(relative).parent
        while parent != PurePosixPath("."):
            expected_directories.add(parent.as_posix())
            parent = parent.parent
    observed_files = set()
    observed_directories = set()
    pending = [release]
    while pending:
        directory = pending.pop()
        for entry in os.scandir(directory):
            relative = Path(entry.path).relative_to(release).as_posix()
            entry_stat = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(entry_stat.st_mode):
                fail(f"installed runtime tree contains a symlink: {relative}")
            if stat.S_ISDIR(entry_stat.st_mode):
                if relative not in expected_directories:
                    fail(f"installed runtime tree contains an extra directory: {relative}")
                observed_directories.add(relative)
                pending.append(Path(entry.path))
            elif stat.S_ISREG(entry_stat.st_mode):
                if relative not in expected_files:
                    fail(f"installed runtime tree contains an extra file: {relative}")
                observed_files.add(relative)
            else:
                fail(f"installed runtime tree contains an unsafe entry: {relative}")
    if observed_files != expected_files or observed_directories != expected_directories:
        fail("installed runtime tree is incomplete")
    for item in manifest["files"]:
        payload = read_regular(
            release / item["path"], MAX_FILE_BYTES, f"installed runtime file {item['path']}",
            item["size"], item["mode"],
        )
        if hashlib.sha256(payload).hexdigest() != item["sha256"]:
            fail(f"installed runtime file checksum does not match: {item['path']}")
    return manifest

def receipt_paths(root_value, receipt_value):
    root = absolute_path(root_value)
    receipt = absolute_path(receipt_value)
    if receipt.parent != root.parent or receipt.name != "wtmux-runtime-trust-v1.json":
        fail("Windows runtime trust receipt path is invalid")
    return root, receipt

def receipt_records(path, allow_missing=False):
    if allow_missing and not os.path.lexists(path):
        return {}
    receipt = exact(parse_json(read_regular(path, MAX_RECEIPT_BYTES, "Windows runtime trust receipt"), "Windows runtime trust receipt"), {
        "schemaVersion", "releases",
    }, "Windows runtime trust receipt")
    if receipt["schemaVersion"] != 1 or not isinstance(receipt["releases"], list) or len(receipt["releases"]) > MAX_RECEIPT_RELEASES:
        fail("Windows runtime trust receipt is invalid")
    records = {}
    for item in receipt["releases"]:
        exact(item, {"version", "artifactSha256", "manifestSha256"}, "Windows runtime trust release")
        version = safe_version(item["version"], "Windows runtime trust version")
        safe_digest(item["artifactSha256"], "Windows runtime artifact checksum")
        safe_digest(item["manifestSha256"], "Windows runtime manifest checksum")
        if version in records:
            fail("Windows runtime trust receipt contains a duplicate release")
        records[version] = item
    return records

def write_receipt(path, records):
    releases = [records[version] for version in sorted(records)]
    if len(releases) > MAX_RECEIPT_RELEASES:
        fail("Windows runtime trust receipt contains too many releases")
    atomic_bytes(path, (json.dumps({"schemaVersion": 1, "releases": releases}, indent=2, sort_keys=True) + "\n").encode(), 0o600)

def trusted_record(records, target):
    version = safe_target(target, "runtime release", allow_empty=False).removeprefix("releases/")
    record = records.get(version)
    if record is None:
        fail(f"runtime release has no Windows trust receipt: {version}")
    return record

def context_path(root):
    return root / "activation-authority-v1.json"

def validate_context_record(value):
    if value is None:
        return None
    exact(value, {"version", "artifactSha256", "manifestSha256"}, "prior Windows runtime trust release")
    safe_version(value["version"], "prior Windows runtime trust version")
    safe_digest(value["artifactSha256"], "prior Windows runtime artifact checksum")
    safe_digest(value["manifestSha256"], "prior Windows runtime manifest checksum")
    return value

def validate_context(value):
    exact(value, {
        "schemaVersion", "activationId", "kind", "candidate", "fromCurrent", "fromPrevious",
        "fromBaseline", "candidateCreated", "priorReceipt", "phase", "registry",
    }, "runtime activation authority context")
    if (
        value["schemaVersion"] != 1
        or not isinstance(value["activationId"], str)
        or not re.fullmatch(r"[a-f0-9]{32}", value["activationId"])
        or value["kind"] not in {"install", "rollback"}
        or not isinstance(value["candidateCreated"], bool)
        or value["phase"] not in {"prepared", "runtime-active", "registry-prepared", "registry-active"}
    ):
        fail("runtime activation authority context is invalid")
    safe_target(value["candidate"], "runtime activation candidate", allow_empty=False)
    safe_target(value["fromCurrent"], "runtime activation prior current")
    safe_target(value["fromPrevious"], "runtime activation prior previous")
    safe_target(value["fromBaseline"], "runtime activation prior baseline")
    if value["candidateCreated"] and value["candidate"] in {
        value["fromCurrent"], value["fromPrevious"], value["fromBaseline"],
    }:
        fail("new runtime candidate was already referenced before activation")
    validate_context_record(value["priorReceipt"])
    registry = exact(value["registry"], {
        "candidate", "fromCurrent", "fromPrevious", "candidateCreated", "configPath",
        "configExisted", "configPayload", "configMode", "configAfterSha256",
    }, "registry activation authority context")
    safe_target(registry["candidate"], "registry activation candidate")
    safe_target(registry["fromCurrent"], "registry activation prior current")
    safe_target(registry["fromPrevious"], "registry activation prior previous")
    if (
        not isinstance(registry["candidateCreated"], bool)
        or not isinstance(registry["configPath"], str) or len(registry["configPath"]) > 4096
        or not isinstance(registry["configExisted"], bool)
        or not isinstance(registry["configPayload"], str)
        or not isinstance(registry["configMode"], int) or isinstance(registry["configMode"], bool)
        or not (0 <= registry["configMode"] <= 0o777)
        or not isinstance(registry["configAfterSha256"], str)
        or (registry["configAfterSha256"] != "" and not DIGEST_RE.fullmatch(registry["configAfterSha256"]))
    ):
        fail("registry activation authority context is invalid")
    try:
        config_payload = base64.b64decode(registry["configPayload"], validate=True)
    except (ValueError, TypeError) as error:
        raise RuntimeError("registry activation prior configuration is invalid") from error
    if len(config_payload) > MAX_CONFIG_BYTES or (not registry["configExisted"] and config_payload):
        fail("registry activation prior configuration is invalid")
    if registry["candidateCreated"] and registry["candidate"] in {
        registry["fromCurrent"], registry["fromPrevious"],
    }:
        fail("new registry candidate was already referenced before activation")
    return value

def read_context(root, allow_missing=False):
    path = context_path(root)
    if allow_missing and not os.path.lexists(path):
        return None
    return validate_context(parse_json(
        read_regular(path, MAX_CONTEXT_BYTES, "runtime activation authority context"),
        "runtime activation authority context",
    ))

def write_context(root, value):
    validate_context(value)
    atomic_bytes(context_path(root), (json.dumps(value, indent=2, sort_keys=True) + "\n").encode(), 0o600)

def remove_context(root):
    path = context_path(root)
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail("runtime activation authority context is unsafe")
    path.unlink()
    fsync_directory(root)

def empty_registry_context():
    return {
        "candidate": "", "fromCurrent": "", "fromPrevious": "",
        "candidateCreated": False, "configPath": "", "configExisted": False, "configPayload": "",
        "configMode": 0, "configAfterSha256": "",
    }

def write_journal(root, transaction_id, from_current, from_previous, candidate, phase, failure=""):
    if not isinstance(transaction_id, str) or not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
        fail("runtime activation transaction is invalid")
    value = {
        "schemaVersion": 1, "transactionId": transaction_id, "phase": phase,
        "fromCurrent": from_current, "fromPrevious": from_previous, "candidate": candidate,
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "failureCode": failure,
    }
    atomic_bytes(root / "activation-journal-v1.json", (json.dumps(value, indent=2, sort_keys=True) + "\n").encode(), 0o600)

def read_journal(root):
    value = exact(parse_json(
        read_regular(root / "activation-journal-v1.json", MAX_RECEIPT_BYTES, "runtime activation journal"),
        "runtime activation journal",
    ), {
        "schemaVersion", "transactionId", "phase", "fromCurrent", "fromPrevious",
        "candidate", "updatedAt", "failureCode",
    }, "runtime activation journal")
    if (
        value["schemaVersion"] != 1
        or not isinstance(value["transactionId"], str)
        or not re.fullmatch(r"[a-f0-9]{32}", value["transactionId"])
    ):
        fail("runtime activation journal is invalid")
    safe_target(value["fromCurrent"], "runtime journal current")
    safe_target(value["fromPrevious"], "runtime journal previous")
    safe_target(value["candidate"], "runtime journal candidate", allow_empty=False)
    return value

def validate_launchers(root, bin_dir, target):
    release = root / target
    for command in PUBLIC_COMMANDS:
        path = release / "scripts" / command
        metadata = os.lstat(path)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            fail(f"runtime is missing public command: {command}")
        launcher = bin_dir / command
        if os.path.lexists(launcher) and not launcher.is_symlink():
            fail(f"refusing to replace non-symlink launcher: {launcher}")

def install_launchers(root, bin_dir):
    bin_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    for command in PUBLIC_COMMANDS:
        launcher = bin_dir / command
        desired = str(root / "current" / "scripts" / command)
        if launcher.is_symlink() and os.readlink(launcher) == desired:
            continue
        if os.path.lexists(launcher) and not launcher.is_symlink():
            fail(f"refusing to replace non-symlink launcher: {launcher}")
        temporary = bin_dir / f".{command}.{uuid.uuid4().hex}"
        os.symlink(desired, temporary)
        try:
            os.replace(temporary, launcher)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

def remove_launchers(root, bin_dir):
    for command in PUBLIC_COMMANDS:
        launcher = bin_dir / command
        if launcher.is_symlink() and os.readlink(launcher) == str(root / "current" / "scripts" / command):
            launcher.unlink()

def activate(root, receipt, bin_dir, target, operation, transaction_id):
    records = receipt_records(receipt)
    record = trusted_record(records, target)
    manifest = validate_release(root, target, record["manifestSha256"])
    old_current = read_link(root, "current")
    old_previous = read_link(root, "previous")
    validate_launchers(root, bin_dir, target)
    write_journal(root, transaction_id, old_current, old_previous, target, "pointers-switching")
    try:
        if old_current and old_current != target:
            switch_link(root, "previous", old_current)
        switch_link(root, "current", target)
        install_launchers(root, bin_dir)
        write_journal(root, transaction_id, old_current, old_previous, target, "committed")
    except Exception:
        if old_current:
            switch_link(root, "current", old_current)
            install_launchers(root, bin_dir)
        else:
            remove_link(root, "current")
            remove_launchers(root, bin_dir)
        if old_previous:
            switch_link(root, "previous", old_previous)
        else:
            remove_link(root, "previous")
        write_journal(root, transaction_id, old_current, old_previous, target, "committed", "activation_rolled_back")
        raise
    return {
        "status": operation, "version": manifest["version"],
        "previous": old_current.removeprefix("releases/"), "activationId": transaction_id,
    }

def command_install(arguments):
    if len(arguments) != 10:
        fail("trusted runtime install arguments are invalid")
    bundle, size, artifact_digest, version, manifest_digest, root_value, receipt_value, bin_value, baseline_value, transaction_id = arguments
    if not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
        fail("runtime activation transaction is invalid")
    snapshot = snapshot_artifact(bundle, size, artifact_digest, "runtime artifact")
    manifest_payload, manifest, members = verified_runtime_payloads(snapshot, version, manifest_digest)
    root, receipt = receipt_paths(root_value, receipt_value)
    bin_dir = absolute_path(bin_value)
    baseline = baseline_value == "1"
    if baseline_value not in {"0", "1"}:
        fail("runtime baseline flag is invalid")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    (root / "releases").mkdir(exist_ok=True, mode=0o700)
    lock = runtime_lock(root)
    temporary = root / "releases" / f".{version}.{uuid.uuid4().hex}"
    context = None
    try:
        pending = read_context(root, allow_missing=True)
        if pending is not None:
            compensate_context(root, receipt, bin_dir, pending)
        release = root / "releases" / version
        created = not os.path.lexists(release)
        records = receipt_records(receipt, allow_missing=True)
        prior_record = records.get(version)
        if not created and (
            prior_record is None
            or prior_record["artifactSha256"] != artifact_digest
            or prior_record["manifestSha256"] != manifest_digest
        ):
            fail("runtime version was reused with a different or missing trusted artifact identity")
        context = {
            "schemaVersion": 1,
            "activationId": transaction_id,
            "kind": "install",
            "candidate": f"releases/{version}",
            "fromCurrent": read_link(root, "current"),
            "fromPrevious": read_link(root, "previous"),
            "fromBaseline": read_link(root, "baseline"),
            "candidateCreated": created,
            "priorReceipt": prior_record,
            "phase": "prepared",
            "registry": empty_registry_context(),
        }
        write_context(root, context)
        if os.path.lexists(release):
            metadata = os.lstat(release)
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                fail("runtime release path is unsafe")
            validate_release(root, f"releases/{version}", manifest_digest)
        else:
            write_release(temporary, manifest_payload, manifest, members)
            os.replace(temporary, release)
            fsync_directory(release.parent)
        records[version] = {
            "version": version, "artifactSha256": artifact_digest, "manifestSha256": manifest_digest,
        }
        write_receipt(receipt, records)
        result = activate(root, receipt, bin_dir, f"releases/{version}", "active", transaction_id)
        if baseline:
            switch_link(root, "baseline", f"releases/{version}")
        context["phase"] = "runtime-active"
        write_context(root, context)
    except Exception:
        if context is not None and read_context(root, allow_missing=True) is not None:
            compensate_context(root, receipt, bin_dir, context)
        raise
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
    result["baseline"] = read_link(root, "baseline").removeprefix("releases/")
    print(json.dumps(result, sort_keys=True))

def parse_registry_manifest(payload):
    manifest = exact(parse_json(payload, "registry manifest"), {"formatVersion", "schemaVersion", "records"}, "registry manifest")
    records = manifest["records"]
    if manifest["formatVersion"] != 1 or manifest["schemaVersion"] != 1 or not isinstance(records, list) or not (1 <= len(records) <= 256):
        fail("registry manifest identity is invalid")
    seen = set()
    for item in records:
        exact(item, {"id", "path", "sha256", "size"}, "registry record")
        machine = item["id"]
        expected = f"machines/{machine}.json"
        if not isinstance(machine, str) or not MACHINE_RE.fullmatch(machine) or item["path"] != expected or expected in seen:
            fail("registry manifest path is invalid or duplicated")
        safe_digest(item["sha256"], "registry record checksum")
        if not isinstance(item["size"], int) or isinstance(item["size"], bool) or not (1 <= item["size"] <= 64 * 1024):
            fail("registry record size is invalid")
        seen.add(expected)
    return manifest

def write_registry(target, manifest_payload, manifest, members):
    machines = target / "machines"
    machines.mkdir(parents=True, mode=0o700)
    for item in manifest["records"]:
        payload, mode = members[item["path"]]
        if mode != 0o644 or len(payload) != item["size"] or hashlib.sha256(payload).hexdigest() != item["sha256"]:
            fail(f"registry record integrity check failed: {item['id']}")
        descriptor = os.open(machines / f"{item['id']}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            written = 0
            while written < len(payload):
                count = os.write(descriptor, payload[written:])
                if count <= 0:
                    fail(f"cannot write registry record: {item['id']}")
                written += count
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    atomic_bytes(target / "registry-manifest.json", manifest_payload, 0o600)

def validate_registry_release(release, manifest_payload, manifest):
    metadata = os.lstat(release)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail("registry release path is unsafe")
    expected_files = {"registry-manifest.json", *(item["path"] for item in manifest["records"])}
    observed_files = set()
    observed_directories = set()
    pending = [release]
    while pending:
        directory = pending.pop()
        for entry in os.scandir(directory):
            relative = Path(entry.path).relative_to(release).as_posix()
            entry_stat = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(entry_stat.st_mode):
                fail(f"installed registry contains a symlink: {relative}")
            if stat.S_ISDIR(entry_stat.st_mode):
                if relative != "machines":
                    fail(f"installed registry contains an extra directory: {relative}")
                observed_directories.add(relative)
                pending.append(Path(entry.path))
            elif stat.S_ISREG(entry_stat.st_mode):
                if relative not in expected_files:
                    fail(f"installed registry contains an extra file: {relative}")
                observed_files.add(relative)
            else:
                fail(f"installed registry contains an unsafe entry: {relative}")
    if observed_files != expected_files or observed_directories != {"machines"}:
        fail("installed registry tree is incomplete")
    if read_regular(
        release / "registry-manifest.json", MAX_FILE_BYTES, "installed registry manifest",
        len(manifest_payload), 0o600,
    ) != manifest_payload:
        fail("registry release already exists with different contents")
    for item in manifest["records"]:
        payload = read_regular(
            release / item["path"], 64 * 1024, f"installed registry record {item['id']}",
            item["size"], 0o600,
        )
        if hashlib.sha256(payload).hexdigest() != item["sha256"]:
            fail(f"installed registry record checksum does not match: {item['id']}")

def legacy_registry_config_payload(payload, registry_path=None):
    try:
        lines = payload.decode("utf-8").splitlines()
    except UnicodeError as error:
        raise RuntimeError("wtmux configuration is not valid UTF-8") from error
    for label in ("wtmux-fleet configuration", "wtmux-runtime registry", "wtmux-managed shared-registry"):
        begin, end = f"# BEGIN {label}", f"# END {label}"
        if begin in lines or end in lines:
            if lines.count(begin) != 1 or lines.count(end) != 1 or lines.index(begin) >= lines.index(end):
                fail("runtime registry config markers are malformed")
            del lines[lines.index(begin):lines.index(end) + 1]
    # The verified loader initializes host membership; a template's empty
    # initializer must not erase it after the prepended projection.
    lines = [line for line in lines if line.strip() != "WTMUX_MACHINE_IDS=()"
             and not line.lstrip().startswith("wtmux_load_shared_registry ")]
    if registry_path is not None:
        escaped = str(registry_path).replace("'", "'\"'\"'")
        block = [REGISTRY_BEGIN, f"WTMUX_SHARED_REGISTRY_DIR='{escaped}'",
                 f"wtmux_load_shared_registry '{escaped}'", REGISTRY_END]
        lines = block + lines
    return ("\n".join(lines) + "\n").encode()

def runtime_config_renderer(root, current, runtime_manifest):
    """Render wtmux.conf with the verified runtime's own writer.

    One implementation owns the shell projection. Only runtimes that predate
    render-config keep the legacy projection above.
    """
    if runtime_manifest["components"]["clientRuntime"]["sequence"] < CONFIG_RENDERER_MIN_SEQUENCE:
        return legacy_registry_config_payload
    release = root / current
    files = {item["path"]: item for item in runtime_manifest["files"]}
    writer = [files.get(path) for path in ("scripts/wtmux-fleet-config", "lib/fleet_registry.py")]
    if None in writer:
        fail("verified runtime has no fleet configuration writer")

    def render(payload, registry_path):
        for item in writer:
            data = read_regular(
                release / item["path"], MAX_FILE_BYTES, f"verified runtime file {item['path']}",
                item["size"], item["mode"],
            )
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                fail(f"verified runtime file checksum does not match: {item['path']}")
        result = subprocess.run(
            ["python3", "-B", str(release / "scripts" / "wtmux-fleet-config"),
             "render-config", "--machines", str(registry_path)],
            input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        if result.returncode != 0 or not result.stdout or len(result.stdout) > MAX_CONFIG_BYTES:
            fail("verified runtime could not render the wtmux configuration")
        return result.stdout

    return render

def configure_registry(config, registry_path, render):
    payload = read_regular(
        config, MAX_CONFIG_BYTES, "wtmux configuration",
    ) if os.path.lexists(config) else b"WTMUX_MACHINE_IDS=()\n"
    atomic_bytes(config, render(payload, registry_path), 0o600)

def restore_link(root, name, target):
    if target:
        switch_link(root, name, target)
    else:
        remove_link(root, name)

def quarantine_created_release(root, target, label):
    if not target:
        return
    safe_target(target, f"{label} release", allow_empty=False)
    release = root / target
    if not os.path.lexists(release):
        return
    metadata = os.lstat(release)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail(f"{label} release path is unsafe")
    rejected = root / "rejected"
    rejected.mkdir(exist_ok=True, mode=0o700)
    os.replace(release, rejected / f"{Path(target).name}-{uuid.uuid4().hex}")
    fsync_directory(rejected)
    fsync_directory(root / "releases")

def compensate_context(root, receipt, bin_dir, context):
    context = validate_context(context)
    candidate = context["candidate"]
    current = read_link(root, "current")
    previous = read_link(root, "previous")
    baseline = read_link(root, "baseline")
    if current not in {candidate, context["fromCurrent"]}:
        fail("runtime activation was superseded before compensation")
    expected_previous = {context["fromPrevious"]}
    if context["fromCurrent"] and context["fromCurrent"] != candidate:
        expected_previous.add(context["fromCurrent"])
    if previous not in expected_previous or baseline not in {context["fromBaseline"], candidate}:
        fail("runtime activation pointers were superseded before compensation")
    if current == candidate and not (
        context["phase"] == "prepared" and candidate == context["fromCurrent"]
    ):
        journal = read_journal(root)
        if journal["transactionId"] != context["activationId"] or journal["candidate"] != candidate:
            fail("runtime activation was superseded before compensation")

    registry = context["registry"]
    if registry["candidate"]:
        registry_root = root / "registry"
        registry_current = read_link(registry_root, "current")
        registry_previous = read_link(registry_root, "previous")
        if registry_current not in {registry["candidate"], registry["fromCurrent"]}:
            fail("registry activation was superseded before compensation")
        expected_registry_previous = {registry["fromPrevious"]}
        if registry["fromCurrent"] and registry["fromCurrent"] != registry["candidate"]:
            expected_registry_previous.add(registry["fromCurrent"])
        if registry_previous not in expected_registry_previous:
            fail("registry activation pointers were superseded before compensation")
        restore_link(registry_root, "current", registry["fromCurrent"])
        restore_link(registry_root, "previous", registry["fromPrevious"])
        if registry["candidateCreated"]:
            quarantine_created_release(registry_root, registry["candidate"], "rejected registry")

    if registry["configPath"]:
        config = absolute_path(registry["configPath"])
        prior_config = base64.b64decode(registry["configPayload"], validate=True)
        if os.path.lexists(config):
            current_config = read_regular(config, MAX_CONFIG_BYTES, "wtmux configuration")
            current_digest = hashlib.sha256(current_config).hexdigest()
            before_matches = registry["configExisted"] and current_config == prior_config
            after_matches = current_digest == registry["configAfterSha256"]
            if not before_matches and not after_matches:
                fail("wtmux configuration changed after registry activation; preserving the newer edit")
            if after_matches:
                if registry["configExisted"]:
                    atomic_bytes(config, prior_config, registry["configMode"])
                else:
                    config.unlink()
                    fsync_directory(config.parent)
        elif registry["configExisted"]:
            fail("wtmux configuration changed after registry activation; preserving the newer edit")

    records = receipt_records(receipt, allow_missing=True)
    version = candidate.removeprefix("releases/")
    if context["priorReceipt"] is None:
        records.pop(version, None)
    else:
        records[version] = context["priorReceipt"]
    write_receipt(receipt, records)
    restore_link(root, "current", context["fromCurrent"])
    restore_link(root, "previous", context["fromPrevious"])
    restore_link(root, "baseline", context["fromBaseline"])
    if context["fromCurrent"]:
        record = trusted_record(records, context["fromCurrent"])
        validate_release(root, context["fromCurrent"], record["manifestSha256"])
        install_launchers(root, bin_dir)
    else:
        remove_launchers(root, bin_dir)
    if context["candidateCreated"]:
        quarantine_created_release(root, candidate, "rejected runtime")
    write_journal(
        root, context["activationId"], context["fromCurrent"], context["fromPrevious"],
        candidate, "committed",
    )
    remove_context(root)
    return {"status": "recovered", "current": context["fromCurrent"].removeprefix("releases/")}

def command_install_registry(arguments):
    if len(arguments) != 8:
        fail("trusted registry install arguments are invalid")
    bundle, size, digest, root_value, receipt_value, config_value, expected_records_value, transaction_id = arguments
    if not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
        fail("runtime activation transaction is invalid")
    snapshot = snapshot_artifact(bundle, size, digest, "registry artifact")
    members = archive_members(snapshot, "registry archive")
    manifest_entry = members.get("registry-manifest.json")
    if manifest_entry is None:
        fail("registry archive has no manifest")
    manifest = parse_registry_manifest(manifest_entry[0])
    try:
        expected_records = int(expected_records_value)
    except ValueError as error:
        raise RuntimeError("registry record count is invalid") from error
    if len(manifest["records"]) != expected_records:
        fail("registry record count does not match the descriptor")
    expected = {"registry-manifest.json", *(item["path"] for item in manifest["records"])}
    if set(members) != expected:
        fail("registry archive contents do not match its manifest")
    root, receipt = receipt_paths(root_value, receipt_value)
    config = absolute_path(config_value)
    release_id = digest
    registry_root = root / "registry"
    releases = registry_root / "releases"
    releases.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = runtime_lock(root)
    temporary = releases / f".{release_id}.{uuid.uuid4().hex}"
    try:
        context = read_context(root, allow_missing=True)
        current = read_link(root, "current")
        records = receipt_records(receipt)
        runtime_record = trusted_record(records, current)
        runtime_manifest = validate_release(root, current, runtime_record["manifestSha256"])
        render = runtime_config_renderer(root, current, runtime_manifest)
        # The APK/desktop registry is a bootstrap seed. A verified activation
        # belongs to the user and survives runtime repair and application restart.
        preserved_path = None
        resolver = root / current / "lib" / "fleet_registry.py"
        if resolver.is_file():
            active = subprocess.run(
                ["python3", str(resolver), "--active", str(root)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=False,
            )
            if active.returncode == 0:
                preserved_path = Path(active.stdout.decode("utf-8").strip())
            elif active.returncode != 3:
                fail("REGISTRY_INVALID: preserving the failed activation for configuration repair")
        elif os.path.lexists(root / "fleet-config" / "current"):
            fail("active fleet configuration requires a runtime with configuration validation")
        elif os.path.lexists(registry_root / "current"):
            prior = registry_root / read_link(registry_root, "current")
            prior_payload = read_regular(prior / "registry-manifest.json", MAX_FILE_BYTES, "active registry manifest")
            prior_manifest = parse_registry_manifest(prior_payload)
            validate_registry_release(prior, prior_payload, prior_manifest)
            preserved_path = registry_root / "current" / "machines"
        if context is None:
            context = {
                "schemaVersion": 1,
                "activationId": transaction_id,
                "kind": "install",
                "candidate": current,
                "fromCurrent": current,
                "fromPrevious": read_link(root, "previous"),
                "fromBaseline": read_link(root, "baseline"),
                "candidateCreated": False,
                "priorReceipt": runtime_record,
                "phase": "runtime-active",
                "registry": empty_registry_context(),
            }
            write_journal(
                root, transaction_id, current, context["fromPrevious"], current, "committed",
            )
            write_context(root, context)
        elif context["activationId"] != transaction_id or context["phase"] not in {"runtime-active", "registry-prepared"}:
            fail("registry activation does not belong to the pending runtime transaction")
        validator_item = next(
            (item for item in runtime_manifest["files"] if item["path"] == "scripts/wtmux-registry"),
            None,
        )
        if validator_item is None:
            fail("verified runtime has no registry validator")
        validator_payload = read_regular(
            root / current / "scripts" / "wtmux-registry", MAX_FILE_BYTES,
            "verified registry validator", validator_item["size"], validator_item["mode"],
        )
        if hashlib.sha256(validator_payload).hexdigest() != validator_item["sha256"]:
            fail("verified registry validator checksum does not match")
        release = releases / release_id
        created = preserved_path is None and not os.path.lexists(release)
        candidate_target = read_link(registry_root, "current") if preserved_path else f"releases/{release_id}"
        configured_registry = preserved_path or registry_root / "current" / "machines"
        if context["phase"] == "runtime-active":
            config_existed = os.path.lexists(config)
            if config_existed:
                config_metadata = os.lstat(config)
                config_payload = read_regular(config, MAX_CONFIG_BYTES, "wtmux configuration")
                config_mode = stat.S_IMODE(config_metadata.st_mode)
                source_config = config_payload
            else:
                config_payload = b""
                config_mode = 0
                source_config = b"WTMUX_MACHINE_IDS=()\n"
            configured_payload = render(source_config, configured_registry)
            context["registry"] = {
                "candidate": candidate_target,
                "fromCurrent": read_link(registry_root, "current"),
                "fromPrevious": read_link(registry_root, "previous"),
                "candidateCreated": created,
                "configPath": str(config),
                "configExisted": config_existed,
                "configPayload": base64.b64encode(config_payload).decode("ascii"),
                "configMode": config_mode,
                "configAfterSha256": hashlib.sha256(configured_payload).hexdigest(),
            }
            context["phase"] = "registry-prepared"
            write_context(root, context)
        elif context["registry"]["candidate"] != candidate_target:
            fail("registry activation retry does not match its pending transaction")
        if preserved_path is not None:
            configure_registry(config, configured_registry, render)
            context["phase"] = "registry-active"
            write_context(root, context)
            print(json.dumps({"status": "preserved"}, sort_keys=True))
            return
        if os.path.lexists(release):
            validate_registry_release(release, manifest_entry[0], manifest)
        else:
            write_registry(temporary, manifest_entry[0], manifest, members)
            result = subprocess.run(
                ["python3", "-c", validator_payload.decode("utf-8"), "validate", str(temporary / "machines")],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15, check=False,
            )
            if result.returncode != 0:
                fail("registry bundle failed strict machine validation")
            os.replace(temporary, release)
            fsync_directory(releases)
        old_current = read_link(registry_root, "current")
        new_current = f"releases/{release_id}"
        if old_current and old_current != new_current:
            switch_link(registry_root, "previous", old_current)
        switch_link(registry_root, "current", new_current)
        configure_registry(config, registry_root / "current" / "machines", render)
        context["phase"] = "registry-active"
        write_context(root, context)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
    print(json.dumps({"status": "active", "registry": release_id, "records": len(manifest["records"])}, sort_keys=True))

def command_rollback(arguments):
    if len(arguments) != 4:
        fail("trusted runtime rollback arguments are invalid")
    root, receipt = receipt_paths(arguments[0], arguments[1])
    bin_dir = absolute_path(arguments[2])
    transaction_id = arguments[3]
    if not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
        fail("runtime activation transaction is invalid")
    lock = runtime_lock(root)
    context = None
    try:
        pending = read_context(root, allow_missing=True)
        if pending is not None:
            compensate_context(root, receipt, bin_dir, pending)
        current = read_link(root, "current")
        previous = read_link(root, "previous")
        if not current or not previous:
            fail("no verified previous runtime is available")
        records = receipt_records(receipt)
        previous_record = trusted_record(records, previous)
        validate_release(root, previous, previous_record["manifestSha256"])
        context = {
            "schemaVersion": 1,
            "activationId": transaction_id,
            "kind": "rollback",
            "candidate": previous,
            "fromCurrent": current,
            "fromPrevious": previous,
            "fromBaseline": read_link(root, "baseline"),
            "candidateCreated": False,
            "priorReceipt": previous_record,
            "phase": "prepared",
            "registry": empty_registry_context(),
        }
        write_context(root, context)
        result = activate(root, receipt, bin_dir, previous, "rolled-back", transaction_id)
        context["phase"] = "runtime-active"
        write_context(root, context)
    except Exception:
        if context is not None and read_context(root, allow_missing=True) is not None:
            compensate_context(root, receipt, bin_dir, context)
        raise
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
    print(json.dumps(result, sort_keys=True))

def command_abort(arguments):
    if len(arguments) != 4:
        fail("trusted runtime abort arguments are invalid")
    root, receipt = receipt_paths(arguments[0], arguments[1])
    bin_dir = absolute_path(arguments[2])
    transaction_id = arguments[3]
    if not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
        fail("runtime activation transaction is invalid")
    if not os.path.lexists(root):
        print(json.dumps({"status": "absent"}, sort_keys=True))
        return
    lock = runtime_lock(root)
    try:
        context = read_context(root, allow_missing=True)
        if context is None:
            print(json.dumps({"status": "absent"}, sort_keys=True))
            return
        if context["activationId"] != transaction_id:
            print(json.dumps({"status": "superseded"}, sort_keys=True))
            return
        result = compensate_context(root, receipt, bin_dir, context)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
    print(json.dumps(result, sort_keys=True))

def command_recover(arguments):
    if len(arguments) != 4:
        fail("trusted runtime recovery arguments are invalid")
    root, receipt = receipt_paths(arguments[0], arguments[1])
    bin_dir = absolute_path(arguments[2])
    allowed = arguments[3]
    if allowed != "-" and not re.fullmatch(r"[a-f0-9]{32}", allowed):
        fail("runtime recovery owner is invalid")
    if not os.path.lexists(root):
        print(json.dumps({"status": "absent"}, sort_keys=True))
        return
    lock = runtime_lock(root)
    try:
        context = read_context(root, allow_missing=True)
        if context is None:
            result = {"status": "clean"}
        elif context["activationId"] == allowed:
            result = {"status": "pending", "activationId": allowed}
        else:
            result = compensate_context(root, receipt, bin_dir, context)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
    print(json.dumps(result, sort_keys=True))

def command_pending(arguments):
    if len(arguments) != 1:
        fail("trusted runtime pending-state arguments are invalid")
    root = absolute_path(arguments[0])
    if not os.path.lexists(root):
        print(json.dumps({"activationId": ""}, sort_keys=True))
        return
    lock = runtime_lock(root)
    try:
        context = read_context(root, allow_missing=True)
        result = {
            "activationId": context["activationId"] if context else "",
            "phase": context["phase"] if context else "",
        }
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
    print(json.dumps(result, sort_keys=True))

def command_finalize(arguments):
    if len(arguments) != 2:
        fail("trusted runtime finalization arguments are invalid")
    root = absolute_path(arguments[0])
    transaction_id = arguments[1]
    if not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
        fail("runtime activation transaction is invalid")
    lock = runtime_lock(root)
    try:
        context = read_context(root, allow_missing=True)
        if context is None:
            result = {"status": "finalized"}
        else:
            if context["activationId"] != transaction_id:
                fail("runtime finalization was superseded")
            journal = read_journal(root)
            if journal["transactionId"] != transaction_id or read_link(root, "current") != context["candidate"]:
                fail("runtime finalization does not match the active transaction")
            registry = context["registry"]
            if registry["candidate"] and read_link(root / "registry", "current") != registry["candidate"]:
                fail("registry finalization does not match the active transaction")
            remove_context(root)
            result = {"status": "finalized", "activationId": transaction_id}
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
    print(json.dumps(result, sort_keys=True))

def main():
    if len(sys.argv) < 2:
        fail("trusted installer command is missing")
    actions = {
        "install": command_install,
        "install-registry": command_install_registry,
        "rollback": command_rollback,
        "abort": command_abort,
        "recover": command_recover,
        "pending": command_pending,
        "finalize": command_finalize,
    }
    action = actions.get(sys.argv[1])
    if action is None:
        fail("trusted installer command is invalid")
    action(sys.argv[2:])

try:
    main()
except (OSError, RuntimeError, ValueError, tarfile.TarError) as error:
    print(f"agent-fleet-runtime-installer: {error}", file=sys.stderr)
    raise SystemExit(2)
`, 'utf8'), { level: 9 }).toString('base64');
