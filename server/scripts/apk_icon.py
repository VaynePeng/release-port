"""Resolve launcher icon resources from an APK without running or extracting it."""
import base64
import json
import struct
import sys
import zipfile
import xml.etree.ElementTree as ET


def u16(data, offset):
    return struct.unpack_from('<H', data, offset)[0]


def u32(data, offset):
    return struct.unpack_from('<I', data, offset)[0]


def chunks(data, start, end):
    while start < end:
        kind, header, size = struct.unpack_from('<HHI', data, start)
        if header < 8 or size < header or start + size > end:
            raise ValueError('invalid resource chunk')
        yield kind, header, start, size
        start += size


def strings(data, pos):
    header, count, flags, start = u16(data, pos + 2), u32(data, pos + 8), u32(data, pos + 16), u32(data, pos + 20)
    if count > 200000:
        raise ValueError('string pool too large')
    utf8 = bool(flags & 256)

    def length(offset):
        first = data[offset] if utf8 else u16(data, offset)
        step, flag, shift = (1, 128, 8) if utf8 else (2, 32768, 16)
        if first & flag:
            second = data[offset + step] if utf8 else u16(data, offset + step)
            return ((first & (flag - 1)) << shift) | second, offset + step * 2
        return first, offset + step

    result = []
    for index in range(count):
        offset = pos + start + u32(data, pos + header + index * 4)
        size, offset = length(offset)
        if utf8:
            size, offset = length(offset)
        result.append(data[offset:offset + size * (1 if utf8 else 2)].decode('utf-8' if utf8 else 'utf-16le'))
    return result


def xml_nodes(data):
    if data.lstrip().startswith(b'<'):
        return [(node.tag.rsplit('}', 1)[-1], {key.rsplit('}', 1)[-1]: (3, value) for key, value in node.attrib.items()}) for node in ET.fromstring(data).iter()]
    pool, nodes = [], []
    for kind, header, pos, _ in chunks(data, u16(data, 2), len(data)):
        if kind == 1:
            pool = strings(data, pos)
        elif kind == 0x102:
            ext = pos + header
            name = pool[u32(data, ext + 4)]
            start, width, count = struct.unpack_from('<HHH', data, ext + 8)
            attrs = {}
            for i in range(count):
                attr = ext + start + i * width
                key, raw, value_type, value = pool[u32(data, attr + 4)], u32(data, attr + 8), data[attr + 15], u32(data, attr + 16)
                attrs[key] = (value_type, pool[value] if value_type == 3 else value)
                if raw != 0xffffffff and value_type == 3:
                    attrs[key] = (3, pool[raw])
            nodes.append((name, attrs))
    return nodes


def resources(data):
    values, pool = {}, []
    for kind, header, pos, size in chunks(data, u16(data, 2), len(data)):
        if kind == 1:
            pool = strings(data, pos)
        elif kind == 0x200:
            package = u32(data, pos + 8)
            type_offset = u32(data, pos + 284) if header >= 288 else 0
            for child, width, at, _ in chunks(data, pos + header, pos + size):
                if child != 0x201:
                    continue
                type_id, flags, count, entries_start = data[at + 8], data[at + 9], u32(data, at + 12), u32(data, at + 16)
                if count > 200000:
                    raise ValueError('resource table too large')
                config = at + 20
                # Do not pick a locale, night-mode or device-specific alternative.
                if any(data[config + 4:config + 12]) or (u32(data, config) >= 32 and data[config + 29] & 0x30):
                    continue
                density = u16(data, config + 14)
                score = (density == 0xfffe, density if density < 0xfffe else 0, u16(data, config + 24))
                for i in range(count):
                    if flags & 1:  # sparse entry index, offset / 4
                        index, offset = struct.unpack_from('<HH', data, at + width + i * 4)
                        offset *= 4
                    elif flags & 2:
                        index, offset = i, u16(data, at + width + i * 2)
                        offset = 0xffffffff if offset == 0xffff else offset * 4
                    else:
                        index, offset = i, u32(data, at + width + i * 4)
                    if offset == 0xffffffff:
                        continue
                    entry = at + entries_start + offset
                    if u16(data, entry + 2) & 1:
                        continue  # complex resource (style / bag)
                    value = entry + u16(data, entry)
                    value_type, raw = data[value + 3], u32(data, value + 4)
                    resolved = (value_type, pool[raw] if value_type == 3 else raw)
                    key = (package << 24) | ((type_id + type_offset) << 16) | index
                    if key not in values or values[key][0] < score:
                        values[key] = (score, resolved)
    return {key: value for key, (_, value) in values.items()}


def inspect(file_path):
    with zipfile.ZipFile(file_path) as archive:
        def read(name):
            info = archive.getinfo(name)
            if info.file_size > 32 * 1024 * 1024:
                raise ValueError('icon resource too large')
            return archive.read(info)

        table = resources(read('resources.arsc')) if 'resources.arsc' in archive.namelist() else {}

        def resolve(value):
            for _ in range(16):
                if value[0] != 1:
                    return value
                value = table[value[1]]
            raise ValueError('resource reference cycle')

        def layer(value):
            kind, value = resolve(value)
            if kind in (0x1c, 0x1d, 0x1e, 0x1f):
                return {'color': '#%06x' % (value & 0xffffff), 'alpha': ((value >> 24) & 255) / 255}
            if kind == 3 and isinstance(value, str) and value.startswith('#'):
                return {'color': value}
            if kind != 3 or value.endswith('.xml'):
                raise ValueError('暂不支持该 APK 的矢量图标图层，无法可靠还原图标')
            return {'resource': value, 'data': base64.b64encode(read(value)).decode()}

        app = next(attrs for name, attrs in xml_nodes(read('AndroidManifest.xml')) if name == 'application')
        kind, icon = resolve(app['icon'])
        if kind != 3:
            raise ValueError('invalid launcher icon')
        if icon.endswith('.xml'):
            nodes = xml_nodes(read(icon))
            if nodes[0][0] != 'adaptive-icon':
                raise ValueError('暂不支持该 APK 的图标格式，无法可靠还原图标')
            layers = {name: attrs['drawable'] for name, attrs in nodes if name in ('background', 'foreground')}
            return {'kind': 'adaptive', 'resource': icon, 'background': layer(layers['background']), 'foreground': layer(layers['foreground'])}
        return {'kind': 'raster', 'resource': icon, 'foreground': layer((kind, icon))}


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(sys.argv[1])))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
