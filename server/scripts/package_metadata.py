"""Read only package manifests; never extract or execute archive contents."""
import json
import plistlib
import re
import struct
import sys
import zipfile
import xml.etree.ElementTree as ET

ANDROID = 'http://schemas.android.com/apk/res/android'


def protobuf(data):
    position = 0
    def number():
        nonlocal position
        result = 0
        for shift in range(0, 70, 7):
            value = data[position]
            position += 1
            result |= (value & 127) << shift
            if not value & 128:
                return result
        raise ValueError('invalid protobuf')
    result = {}
    while position < len(data):
        tag = number()
        field, kind = tag >> 3, tag & 7
        if kind == 0:
            value = number()
        elif kind == 2:
            length = number()
            value = data[position:position + length]
            position += length
            if len(value) != length:
                raise ValueError('invalid protobuf length')
        elif kind in (1, 5):
            length = 8 if kind == 1 else 4
            value = data[position:position + length]
            position += length
        else:
            raise ValueError('unsupported protobuf field')
        result.setdefault(field, []).append(value)
    return result


def proto_manifest(data):
    node = protobuf(data)
    element = protobuf(node[1][0])
    if element[3][0] != b'manifest':
        raise ValueError('manifest root missing')
    values = {}
    for attribute in element.get(4, []):
        attr = protobuf(attribute)
        namespace = attr.get(1, [b''])[0].decode()
        name = attr[2][0].decode()
        if namespace not in ('', ANDROID):
            continue
        value = attr.get(3, [b''])[0].decode()
        if not value and 6 in attr:
            item = protobuf(attr[6][0])
            if 7 in item:
                primitive = protobuf(item[7][0])
                value = str(primitive.get(6, primitive.get(7, ['']))[0])
            elif 2 in item:
                value = protobuf(item[2][0]).get(1, [b''])[0].decode()
        values[name] = value
    return values


def binary_manifest(data):
    def u16(pos): return struct.unpack_from('<H', data, pos)[0]
    def u32(pos): return struct.unpack_from('<I', data, pos)[0]
    strings = []
    position = u16(2)
    while position + 8 <= len(data):
        kind, header, size = u16(position), u16(position + 2), u32(position + 4)
        if size < header or size < 8 or position + size > len(data):
            raise ValueError('invalid binary XML chunk')
        if kind == 1:
            count, flags, start = u32(position + 8), u32(position + 16), u32(position + 20)
            if count > 100000:
                raise ValueError('string pool too large')
            def length(offset, utf8):
                first = data[offset] if utf8 else u16(offset)
                step, flag = (1, 128) if utf8 else (2, 32768)
                if first & flag:
                    second = data[offset + step] if utf8 else u16(offset + step)
                    return ((first & (flag - 1)) << (7 if utf8 else 16)) | second, offset + step * 2
                return first, offset + step
            for index in range(count):
                offset = position + start + u32(position + header + index * 4)
                utf8 = bool(flags & 256)
                size_chars, offset = length(offset, utf8)
                if utf8:
                    size_chars, offset = length(offset, True)
                strings.append(data[offset:offset + size_chars * (1 if utf8 else 2)].decode('utf-8' if utf8 else 'utf-16le'))
        elif kind == 0x102:
            extension = position + header
            if strings[u32(extension + 4)] == 'manifest':
                start, width, count = u16(extension + 8), u16(extension + 10), u16(extension + 12)
                values = {}
                for index in range(count):
                    attr = extension + start + index * width
                    namespace, name, raw = u32(attr), strings[u32(attr + 4)], u32(attr + 8)
                    if namespace != 0xffffffff and strings[namespace] != ANDROID:
                        continue
                    value_type, value = data[attr + 15], u32(attr + 16)
                    if raw != 0xffffffff:
                        value = strings[raw]
                    elif value_type == 3:
                        value = strings[value]
                    elif value_type not in (0x10, 0x11):
                        value = ''  # Resource references cannot be guessed.
                    values[name] = str(value)
                return values
        position += size
    raise ValueError('manifest root missing')


def inspect(file_path, extension):
    with zipfile.ZipFile(file_path) as archive:
        def read(name):
            info = archive.getinfo(name)
            if info.file_size > 8 * 1024 * 1024:
                raise ValueError('manifest too large')
            return archive.read(info)
        if extension == '.ipa':
            matches = [entry.filename for entry in archive.infolist() if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', entry.filename)]
            if len(matches) != 1:
                raise ValueError('IPA must contain one main app')
            info = plistlib.loads(read(matches[0]))
            result = dict(platform='ios', packageName=info.get('CFBundleIdentifier'), versionName=info.get('CFBundleShortVersionString'), buildNumber=info.get('CFBundleVersion'))
        else:
            data = read('base/manifest/AndroidManifest.xml' if extension == '.aab' else 'AndroidManifest.xml')
            if extension == '.aab':
                values = proto_manifest(data)
            elif data.lstrip().startswith(b'<'):
                element = ET.fromstring(data)
                values = {key.rsplit('}', 1)[-1]: value for key, value in element.attrib.items()}
            else:
                values = binary_manifest(data)
            code = int(values['versionCode'])
            major = int(values.get('versionCodeMajor') or 0)
            result = dict(platform='android', packageName=values.get('package'), versionName=values.get('versionName'), buildNumber=str((major << 32) | code))
        if any(not isinstance(result[key], str) or not result[key].strip() or len(result[key]) > 255 for key in ('packageName', 'versionName', 'buildNumber')):
            raise ValueError('missing package metadata')
        if str(result['versionName']).startswith('@'):
            raise ValueError('unresolved version resource')
        return result


try:
    extension = sys.argv[2].lower()
    if extension not in ('.apk', '.aab', '.ipa'):
        raise ValueError('unsupported format')
    print(json.dumps(inspect(sys.argv[1], extension)))
except Exception:
    print(json.dumps({'error': '无法读取安装包的包名、版本号或构建号，请使用完整有效的 APK / AAB / IPA'}))
    sys.exit(1)
