/**
 * Minimal CBOR decoder — supports only what CIP-8/CIP-30 COSE structures use
 * (unsigned/negative ints, byte/text strings, arrays, maps, tags, simple
 * values), including basic indefinite-length support. Not a general-purpose
 * decoder.
 */

function readLength(buf, offset, additionalInfo) {
  if (additionalInfo < 24) return { length: additionalInfo, offset };
  if (additionalInfo === 24) return { length: buf.readUInt8(offset), offset: offset + 1 };
  if (additionalInfo === 25) return { length: buf.readUInt16BE(offset), offset: offset + 2 };
  if (additionalInfo === 26) return { length: buf.readUInt32BE(offset), offset: offset + 4 };
  if (additionalInfo === 27) {
    const high = buf.readUInt32BE(offset);
    const low = buf.readUInt32BE(offset + 4);
    return { length: Number((BigInt(high) << 32n) | BigInt(low)), offset: offset + 8 };
  }
  throw new Error('Unsupported CBOR length encoding');
}

function decodeIndefinite(buf, pos, majorType) {
  let cur = pos;
  const chunks = [];
  while (buf[cur] !== 0xff) {
    const res = decodeCbor(buf, cur);
    chunks.push(res.value);
    cur = res.offset;
  }
  cur += 1;

  if (majorType === 2) {
    return { value: Buffer.concat(chunks.map((c) => Buffer.from(c))), offset: cur };
  }
  return { value: chunks.join(''), offset: cur };
}

export function decodeCbor(buf, offset = 0) {
  const initialByte = buf[offset];
  const majorType = initialByte >> 5;
  const additionalInfo = initialByte & 0x1f;
  const pos = offset + 1;

  switch (majorType) {
    case 0: {
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      return { value: length, offset: next };
    }
    case 1: {
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      return { value: -1 - length, offset: next };
    }
    case 2: {
      if (additionalInfo === 31) return decodeIndefinite(buf, pos, majorType);
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      return { value: buf.subarray(next, next + length), offset: next + length };
    }
    case 3: {
      if (additionalInfo === 31) return decodeIndefinite(buf, pos, majorType);
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      return { value: buf.toString('utf8', next, next + length), offset: next + length };
    }
    case 4: {
      const items = [];
      if (additionalInfo === 31) {
        let cur = pos;
        while (buf[cur] !== 0xff) {
          const res = decodeCbor(buf, cur);
          items.push(res.value);
          cur = res.offset;
        }
        return { value: items, offset: cur + 1 };
      }
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      let cur = next;
      for (let i = 0; i < length; i += 1) {
        const res = decodeCbor(buf, cur);
        items.push(res.value);
        cur = res.offset;
      }
      return { value: items, offset: cur };
    }
    case 5: {
      const map = new Map();
      if (additionalInfo === 31) {
        let cur = pos;
        while (buf[cur] !== 0xff) {
          const keyRes = decodeCbor(buf, cur);
          const valRes = decodeCbor(buf, keyRes.offset);
          map.set(keyRes.value, valRes.value);
          cur = valRes.offset;
        }
        return { value: map, offset: cur + 1 };
      }
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      let cur = next;
      for (let i = 0; i < length; i += 1) {
        const keyRes = decodeCbor(buf, cur);
        const valRes = decodeCbor(buf, keyRes.offset);
        map.set(keyRes.value, valRes.value);
        cur = valRes.offset;
      }
      return { value: map, offset: cur };
    }
    case 6: {
      const { offset: next } = readLength(buf, pos, additionalInfo);
      return decodeCbor(buf, next);
    }
    case 7: {
      if (additionalInfo === 20) return { value: false, offset: pos };
      if (additionalInfo === 21) return { value: true, offset: pos };
      if (additionalInfo === 22) return { value: null, offset: pos };
      if (additionalInfo === 23) return { value: undefined, offset: pos };
      throw new Error(`Unsupported CBOR simple value: ${additionalInfo}`);
    }
    default:
      throw new Error(`Unsupported CBOR major type: ${majorType}`);
  }
}
