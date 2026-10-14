import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(tag=None):
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    version = manifest['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', version):
        raise ValueError('Invalid manifest version')
    if tag and tag != f'v{version}':
        raise ValueError(f'Tag {tag} does not match manifest version v{version}')
    files = {Path(name) for name in ['manifest.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']}
    for directory in ['src', 'icons']:
        files.update(file.relative_to(ROOT) for file in (ROOT / directory).rglob('*') if file.is_file())
    required = [manifest['background']['service_worker'], manifest['side_panel']['default_path']]
    required += list(manifest['icons'].values())
    required += list(manifest['action']['default_icon'].values())
    required += [file for script in manifest['content_scripts'] for file in script['js']]
    for name in required:
        if Path(name) not in files:
            raise ValueError(f'Missing extension resource: {name}')
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    archive = output / f'chatgpt-chrome-sidepanel-v{version}.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as package:
        for relative in sorted(files):
            source = ROOT / relative
            if source.is_symlink():
                raise ValueError(f'Symlinks are not allowed: {relative}')
            entry = zipfile.ZipInfo(relative.as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            package.writestr(entry, source.read_bytes())
    with zipfile.ZipFile(archive) as package:
        if package.testzip() is not None:
            raise ValueError('ZIP integrity check failed')
        if set(package.namelist()) != {file.as_posix() for file in files}:
            raise ValueError('ZIP file list mismatch')
        json.loads(package.read('manifest.json'))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / 'SHA256SUMS.txt').write_text(f'{checksum}  {archive.name}\n', encoding='utf-8')
    print(f'Built {archive.name}: {len(files)} files, {archive.stat().st_size} bytes')
    print('Verified: manifest at ZIP root; no local context, tests, or development files')
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag')
    build(parser.parse_args().tag)
