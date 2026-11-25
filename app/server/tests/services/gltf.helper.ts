// A glTF 2.0 binary written byte by byte for tests of the 3D asset view (D228): one box mesh
// (positions, normals and indices in the binary chunk) placed by named nodes, so a renderer has
// real geometry to draw and anchors real names to stand on.

/** Each node a box of side 1 at its translation, scaled. */
export function boxesGlb(nodes: { name: string; translation: [number, number, number]; scale?: number }[]): Buffer {
  return meshGlb(boxGeometry(), nodes);
}

/** Each node a sphere of diameter 1, finely divided (segments around, half as many top to bottom): enough to simplify (D249). */
export function spheresGlb(nodes: { name: string; translation: [number, number, number]; scale?: number }[], segments = 96): Buffer {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const rings = segments / 2;
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s <= segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      positions.push(...n.map((x) => x * 0.5));
      normals.push(...n);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return meshGlb({ positions, normals, indices }, nodes, 0);
}

function boxGeometry(): { positions: number[]; normals: number[]; indices: number[] } {
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let i = 0; i < 3; i++) positions.push(0.5 * (n[i]! + a * u[i]! + b * v[i]!));
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

/** metallic: the material's metallic factor, glTF's default 1 where not given (a metal with nothing to reflect draws dark). */
function meshGlb({ positions, normals, indices }: { positions: number[]; normals: number[]; indices: number[] },
  nodes: { name: string; translation: [number, number, number]; scale?: number }[], metallic?: number): Buffer {
  const pos = Buffer.from(new Float32Array(positions).buffer);
  const nor = Buffer.from(new Float32Array(normals).buffer);
  const idx = Buffer.from(new Uint16Array(indices).buffer);
  const bin = Buffer.concat([pos, nor, idx, Buffer.alloc((4 - (idx.length % 4)) % 4)]);
  const doc = {
    asset: { version: '2.0', generator: 'silo tests' },
    scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes: nodes.map((n) => ({ name: n.name, mesh: 0, translation: n.translation, ...(n.scale === undefined ? {} : { scale: [n.scale, n.scale, n.scale] }) })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.1, 0.1, 1], ...(metallic === undefined ? {} : { metallicFactor: metallic }) } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 },
      { buffer: 0, byteOffset: pos.length, byteLength: nor.length, target: 34962 },
      { buffer: 0, byteOffset: pos.length + nor.length, byteLength: idx.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(doc), 'utf8');
  if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length + 8 + bin.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json, binHeader, bin]);
}
