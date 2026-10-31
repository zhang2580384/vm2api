import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native_cli_builder', ROOT / 'deploy/build-native-cli.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class NativeCliBuilderTests(unittest.TestCase):
    def test_source_is_unique_bounded_and_hash_pinned(self):
        source = b'// @bun\nasync function runNativeMessagesLoop(_ctx) {}\nmain2();\n'
        elf = b'prefix\0' + source + b'\0suffix'
        self.assertEqual(builder.extract_source(elf, builder.digest(source)), source)
        for bad in (elf + elf, elf[:-7], b'no source'):
            with self.assertRaises(ValueError):
                builder.extract_source(bad, builder.digest(source))
        with self.assertRaises(ValueError):
            builder.extract_source(elf, '0' * 64)

    def test_runtime_must_be_arm64(self):
        data = bytearray(64)
        data[:6] = b'\x7fELF\x02\x01'
        data[18:20] = (183).to_bytes(2, 'little')
        builder.arm64_elf(data)
        data[18:20] = (62).to_bytes(2, 'little')
        with self.assertRaises(ValueError):
            builder.arm64_elf(data)

    def test_tar_symlink_is_not_executed_or_extracted(self):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w:xz') as archive:
            member = tarfile.TarInfo('tool/upx')
            member.type = tarfile.SYMTYPE
            member.linkname = '/bin/sh'
            archive.addfile(member)
        with self.assertRaises(ValueError):
            builder.archive_member(buf.getvalue(), 'tool/upx', 'tar')

    def test_zip_reads_only_named_member(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as archive:
            archive.writestr('../escape', b'not extracted')
            archive.writestr('bun/bun', b'expected')
        self.assertEqual(builder.archive_member(buf.getvalue(), 'bun/bun', 'zip'), b'expected')

    def test_bad_cache_hash_is_rejected_without_network(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp)
            (cache / ('0' * 64)).write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                builder.download({'sha256': '0' * 64, 'url': 'https://github.com/no-network'}, cache)

    def test_pin_tracks_release_payload(self):
        pin = json.loads((ROOT / 'deploy/arm64-cli.json').read_text())
        payload = json.loads((ROOT / 'deploy/payload.json').read_text())
        cli = next(f for f in payload['files'] if f['path'] == 'share/wrap-cli/cli-node')
        self.assertEqual(pin['cli_sha256'], cli['sha256'], 'review native CLI pin when updating release CLI')

    def test_existing_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload = root / 'cli'
            payload.write_bytes(b'payload')
            out = root / 'output'
            out.mkdir()
            (out / 'keep').write_text('keep')
            with self.assertRaises(ValueError):
                builder.build(payload, out, {'cli_sha256': builder.digest(b'payload')}, root, root / 'cache')
            self.assertEqual((out / 'keep').read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()