self.onmessage = (event) => {
  const { pixels, width, height, lut, size } = event.data;

  const src = new Uint8ClampedArray(pixels);
  const out = new Uint8ClampedArray(pixels.byteLength);
  const lutData = new Float32Array(lut);
  const maxIndex = size - 1;

  const total = width * height;
  for (let p = 0; p < total; p++) {
    const o = p * 4;

    const rN = src[o] / 255;
    const gN = src[o + 1] / 255;
    const bN = src[o + 2] / 255;

    const x = rN * maxIndex;
    const y = gN * maxIndex;
    const z = bN * maxIndex;

    const x0 = x | 0;
    const y0 = y | 0;
    const z0 = z | 0;
    const x1 = x0 < maxIndex ? x0 + 1 : x0;
    const y1 = y0 < maxIndex ? y0 + 1 : y0;
    const z1 = z0 < maxIndex ? z0 + 1 : z0;

    const fx = x - x0;
    const fy = y - y0;
    const fz = z - z0;

    const size2 = size * size;
    const i000 = (z0 * size2 + y0 * size + x0) * 3;
    const i100 = (z0 * size2 + y0 * size + x1) * 3;
    const i010 = (z0 * size2 + y1 * size + x0) * 3;
    const i110 = (z0 * size2 + y1 * size + x1) * 3;
    const i001 = (z1 * size2 + y0 * size + x0) * 3;
    const i101 = (z1 * size2 + y0 * size + x1) * 3;
    const i011 = (z1 * size2 + y1 * size + x0) * 3;
    const i111 = (z1 * size2 + y1 * size + x1) * 3;

    for (let c = 0; c < 3; c++) {
      const c000 = lutData[i000 + c];
      const c100 = lutData[i100 + c];
      const c010 = lutData[i010 + c];
      const c110 = lutData[i110 + c];
      const c001 = lutData[i001 + c];
      const c101 = lutData[i101 + c];
      const c011 = lutData[i011 + c];
      const c111 = lutData[i111 + c];

      const c00 = c000 + (c100 - c000) * fx;
      const c10 = c010 + (c110 - c010) * fx;
      const c01 = c001 + (c101 - c001) * fx;
      const c11 = c011 + (c111 - c011) * fx;

      const c0 = c00 + (c10 - c00) * fy;
      const c1 = c01 + (c11 - c01) * fy;

      const value = c0 + (c1 - c0) * fz;
      out[o + c] = value * 255;
    }
    out[o + 3] = src[o + 3];
  }

  self.postMessage({ result: out.buffer }, [out.buffer]);
};
