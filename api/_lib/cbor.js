/**
 * Minimal CBOR decoder: supports only what CIP-8/CIP-30 COSE structures use
 * (unsigned/negative ints, byte/text strings, arrays, maps, tags, simple
 * values), including basic indefinite-length support. Not a general-purpose
 * decoder.
 *
 * It reads untrusted input, so every read is bounds-checked and the amount of
 * work is capped: a truncated or hostile payload throws instead of looping or
 * allocating without limit.
 */

const MAX_DEPTH = 16;
const MAX_ITEMS = 2_000;
const MAX_INPUT_BYTES = 8_192;

function need(buf, offset, count) {
  if (!Number.isInteger(offset) || offset < 0 || offset + count > buf.length) {
    throw new Error('Truncated CBOR data');
  }
}

function readLength(buf, offset, additionalInfo) {
  if (additionalInfo < 24) return { length: additionalInfo, offset };
  if (additionalInfo === 24) {
    need(buf, offset, 1);
    return { length: buf.readUInt8(offset), offset: offset + 1 };
  }
  if (additionalInfo === 25) {
    need(buf, offset, 2);
    return { length: buf.readUInt16BE(offset), offset: offset + 2 };
  }
  if (additionalInfo === 26) {
    need(buf, offset, 4);
    return { length: buf.readUInt32BE(offset), offset: offset + 4 };
  }
  if (additionalInfo === 27) {
    need(buf, offset, 8);
    const value = (BigInt(buf.readUInt32BE(offset)) << 32n) | BigInt(buf.readUInt32BE(offset + 4));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR length too large');
    return { length: Number(value), offset: offset + 8 };
  }
  throw new Error('Unsupported CBOR length encoding');
}

function countItem(state) {
  state.items += 1;
  if (state.items > MAX_ITEMS) throw new Error('CBOR data too complex');
}

function decodeIndefinite(buf, pos, majorType, state) {
  let cur = pos;
  const chunks = [];
  for (;;) {
    need(buf, cur, 1);
    if (buf[cur] === 0xff) break;
    const res = decode(buf, cur, state);
    chunks.push(res.value);
    cur = res.offset;
  }
  cur += 1;

  if (majorType === 2) {
    return { value: Buffer.concat(chunks.map((c) => Buffer.from(c))), offset: cur };
  }
  return { value: chunks.join(''), offset: cur };
}

function decode(buf, offset, state) {
  need(buf, offset, 1);
  countItem(state);
  state.depth += 1;
  if (state.depth > MAX_DEPTH) throw new Error('CBOR nested too deeply');
  try {
    return decodeItem(buf, offset, state);
  } finally {
    state.depth -= 1;
  }
}

function decodeItem(buf, offset, state) {
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
      if (additionalInfo === 31) return decodeIndefinite(buf, pos, majorType, state);
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      need(buf, next, length);
      return { value: buf.subarray(next, next + length), offset: next + length };
    }
    case 3: {
      if (additionalInfo === 31) return decodeIndefinite(buf, pos, majorType, state);
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      need(buf, next, length);
      return { value: buf.toString('utf8', next, next + length), offset: next + length };
    }
    case 4: {
      const items = [];
      if (additionalInfo === 31) {
        let cur = pos;
        for (;;) {
          need(buf, cur, 1);
          if (buf[cur] === 0xff) break;
          const res = decode(buf, cur, state);
          items.push(res.value);
          cur = res.offset;
        }
        return { value: items, offset: cur + 1 };
      }
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      // Every item takes at least one byte, so a length beyond the remaining bytes is impossible.
      if (length > buf.length - next) throw new Error('Truncated CBOR data');
      let cur = next;
      for (let i = 0; i < length; i += 1) {
        const res = decode(buf, cur, state);
        items.push(res.value);
        cur = res.offset;
      }
      return { value: items, offset: cur };
    }
    case 5: {
      const map = new Map();
      if (additionalInfo === 31) {
        let cur = pos;
        for (;;) {
          need(buf, cur, 1);
          if (buf[cur] === 0xff) break;
          const keyRes = decode(buf, cur, state);
          const valRes = decode(buf, keyRes.offset, state);
          map.set(keyRes.value, valRes.value);
          cur = valRes.offset;
        }
        return { value: map, offset: cur + 1 };
      }
      const { length, offset: next } = readLength(buf, pos, additionalInfo);
      if (length * 2 > buf.length - next) throw new Error('Truncated CBOR data');
      let cur = next;
      for (let i = 0; i < length; i += 1) {
        const keyRes = decode(buf, cur, state);
        const valRes = decode(buf, keyRes.offset, state);
        map.set(keyRes.value, valRes.value);
        cur = valRes.offset;
      }
      return { value: map, offset: cur };
    }
    case 6: {
      const { offset: next } = readLength(buf, pos, additionalInfo);
      return decode(buf, next, state);
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

export function decodeCbor(buf, offset = 0) {
  if (!Buffer.isBuffer(buf)) throw new Error('CBOR input must be a buffer');
  if (buf.length > MAX_INPUT_BYTES) throw new Error('CBOR input too large');
  return decode(buf, offset, { items: 0, depth: 0 });
}
