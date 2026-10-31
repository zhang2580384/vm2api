#!/usr/bin/env python3
"""Build a source-pinned native CLI overlay; never read a live slot or credentials."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

RUNTIME_FILES = ('bun', 'cli.js', 'ld-linux-aarch64.so.1', 'libc.so.6',
                 'libpthread.so.0', 'libdl.so.2', 'libm.so.6')
WRAPPER = '''#!/bin/sh
# native-cli bundle: {digest}
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
R="$DIR/glibc239/arm64"
exec "$R/ld-linux-aarch64.so.1" --library-path "$R" "$R/bun" "$R/cli.js" "$@"
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked(data, expected, label):
    if digest(data) != expected:
        raise ValueError(f'{label}: SHA-256 mismatch')
    return data


def arm64_elf(data):
    if data[:6] != b'\x7fELF\x02\x01' or int.from_bytes(data[18:20], 'little') != 183:
        raise ValueError('runtime file is not a Linux ARM64 ELF')


def extract_source(data, expected):
    marker = b'async function runNativeMessagesLoop(_ctx) {'
    if data.count(marker) != 1:
        raise ValueError('unsupported CLI bundle: native loop is not unique')
    pos = data.index(marker)
    start = data.rfind(b'\0', 0, pos) + 1
    end = data.find(b'\0', pos)
    if end < 0 or end - start > 64 * 1024 * 1024:
        raise ValueError('unsupported CLI source boundary')
    source = data[start:end]
    if not source.startswith(b'// @bun\n') or not source.endswith(b'main2();\n'):
        raise ValueError('unsupported CLI source layout')
    return checked(source, expected, 'embedded CLI source')


def archive_member(data, name, kind):
    # Read only the named regular file; never extract paths supplied by an archive.
    if kind == 'zip':
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo(name)
            if info.is_dir() or info.file_size > 256 * 1024 * 1024:
                raise ValueError('invalid ZIP member')
            return archive.read(info)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        info = archive.getmember(name)
        if not info.isfile() or info.size > 256 * 1024 * 1024:
            raise ValueError('invalid tar member')
        return archive.extractfile(info).read()


def download(tool, cache):
    target = cache / tool['sha256']
    if target.exists():
        return checked(target.read_bytes(), tool['sha256'], target.name)
    if not tool['url'].startswith('https://github.com/'):
        raise ValueError('tools must come from pinned HTTPS GitHub releases')
    with urllib.request.urlopen(tool['url'], timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    if len(data) > 128 * 1024 * 1024:
        raise ValueError('tool archive too large')
    checked(data, tool['sha256'], tool['url'])
    target.write_bytes(data)
    return data


def build(payload, output, manifest, lib_dir, cache):
    packed = checked(payload.read_bytes(), manifest['cli_sha256'], 'pinned cli-node')
    if output.exists():
        raise ValueError('output already exists; use a fresh staging directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    # Stage all output before publishing the directory. A failed build leaves no overlay.
    with tempfile.TemporaryDirectory(prefix='native-cli-', dir=output.parent) as temp:
        work = Path(temp)
        upx_tool = manifest['upx']
        upx = work / 'upx'
        upx.write_bytes(archive_member(download(upx_tool, cache), upx_tool['member'], 'tar'))
        arm64_elf(upx.read_bytes())
        upx.chmod(0o755)
        source_elf = work / 'cli-node'
        source_elf.write_bytes(packed)
        unpacked = work / 'unpacked'
        subprocess.run([str(upx), '-d', '-o', str(unpacked), str(source_elf)],
                       check=True, timeout=120, stdout=subprocess.DEVNULL)
        source = extract_source(unpacked.read_bytes(), manifest['source_sha256'])
        bundle = work / 'overlay'
        runtime = bundle / 'glibc239' / 'arm64'
        runtime.mkdir(parents=True)
        bun_tool = manifest['bun']
        bun = archive_member(download(bun_tool, cache), bun_tool['member'], 'zip')
        arm64_elf(bun)
        checked(bun, bun_tool['binary_sha256'], 'Bun executable')
        (runtime / 'bun').write_bytes(bun)
        (runtime / 'cli.js').write_bytes(source)
        for name in RUNTIME_FILES[2:]:
            data = (lib_dir / name).read_bytes()
            arm64_elf(data)
            (runtime / name).write_bytes(data)
        hashes = {f'glibc239/arm64/{name}': digest((runtime / name).read_bytes())
                  for name in RUNTIME_FILES}
        bundle_id = digest(json.dumps(hashes, sort_keys=True).encode())
        (bundle / 'cli-node').write_text(WRAPPER.format(digest=bundle_id))
        hashes['cli-node'] = digest((bundle / 'cli-node').read_bytes())
        meta = {'schema': 1, 'source_sha256': manifest['cli_sha256'],
                'bun_version': manifest['bun_version'], 'files': hashes}
        (bundle / 'manifest.json').write_text(json.dumps(meta, indent=2) + '\n')
        for file in bundle.rglob('*'):
            if file.is_file():
                file.chmod(0o644 if file.suffix in ('.json', '.js') else 0o755)
            else:
                file.chmod(0o755)
        bundle.chmod(0o755)
        bundle.rename(output)
    return meta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, default=Path('deploy/arm64-cli.json'))
    parser.add_argument('--lib-dir', type=Path, default=Path('/lib/aarch64-linux-gnu'))
    parser.add_argument('--cache', type=Path, default=Path('.local/native-cli-tools'))
    args = parser.parse_args()
    meta = build(args.payload.resolve(), args.output.resolve(),
                 json.loads(args.manifest.read_text()), args.lib_dir, args.cache)
    print(json.dumps({'output': str(args.output), 'source_sha256': meta['source_sha256']}))


if __name__ == '__main__':
    main()